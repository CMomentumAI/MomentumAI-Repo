/**
 * POST /api/webhook/omi
 *
 * Receives audio transcript payloads from the OMI wearable device.
 * Flow:
 *  1. Validate HMAC-SHA256 signature (X-OMI-Signature header)
 *  2. Idempotency check — if session_id was already processed, return 200
 *  3. Create appointment record with status "pending"
 *  4. Store raw transcript in S3
 *  5. Return 202 immediately so OMI doesn't wait or retry
 *  6. After the response is sent, run the AI pipeline via Next.js `after()`
 *     (summarize with Perplexity → store summary → index with Gemini RAG)
 *
 * BACKGROUND PROCESSING MODEL:
 * `after()` (Next.js 15.1+, stable in 16) is the framework-managed hook for
 * post-response work in Node.js / Docker deployments. Unlike `setImmediate`:
 *  - Next.js participates in graceful shutdown, waiting for `after()` callbacks
 *    before exiting when Railway sends SIGTERM during a redeploy.
 *  - A hard SIGKILL (sent after Railway's grace period) can still interrupt
 *    work. The appointment stays in "pending" status in that case and can be
 *    recovered via POST /api/appointments/[id]/summarize.
 *
 * This route is intentionally exempt from session auth — it is verified
 * instead by HMAC-SHA256 signature using OMI_WEBHOOK_SECRET.
 */

import { NextRequest } from "next/server";
import { after } from "next/server";
import { buildS3Key, uploadToS3 } from "@/lib/s3";
import { verifyOmiSignature } from "@/lib/webhook-utils";
import {
  createAppointment,
  findAppointmentBySessionId,
  updateAppointment,
} from "@/lib/appointments";
import { processAppointment } from "@/lib/ai-pipeline";
import { successResponse, errorResponse, getRequestId } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";
import type { OmiWebhookPayload } from "@/types";

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function summarizeHeaders(request: NextRequest): Record<string, string> {
  const allowList = [
    "content-type",
    "content-length",
    "user-agent",
    "x-omi-signature",
    "x-forwarded-for",
    "x-forwarded-proto",
  ];

  const summary: Record<string, string> = {};
  for (const header of allowList) {
    const value = request.headers.get(header);
    if (value) {
      summary[header] =
        header === "x-omi-signature" ? "[present]" : value.slice(0, 200);
    }
  }
  return summary;
}

function summarizePayloadShape(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        bodyType: Array.isArray(parsed) ? "array" : typeof parsed,
      };
    }

    const payload = parsed as Record<string, unknown>;
    const keys = Object.keys(payload).sort();

    return {
      bodyType: "object",
      topLevelKeys: keys,
      hasSessionId: typeof payload.session_id === "string",
      hasPatientId: typeof payload.patient_id === "string",
      hasTranscript: Array.isArray(payload.transcript),
      transcriptCount: Array.isArray(payload.transcript)
        ? payload.transcript.length
        : null,
      hasTranscriptSegments: Array.isArray(payload.transcript_segments),
      transcriptSegmentCount: Array.isArray(payload.transcript_segments)
        ? payload.transcript_segments.length
        : null,
      hasStructured: !!payload.structured,
      hasAppsResponse: !!payload.apps_response,
      hasDiscarded: typeof payload.discarded === "boolean",
    };
  } catch {
    return {
      bodyType: "invalid-json",
      rawBodyLength: rawBody.length,
    };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  let rawBody: string;
  const debugInspectMode = isTruthyEnv(process.env.OMI_WEBHOOK_DEBUG_MODE);
  const skipSignatureVerification = isTruthyEnv(
    process.env.OMI_SKIP_SIGNATURE_VERIFICATION,
  );

  try {
    rawBody = await request.text();
  } catch {
    return errorResponse("Failed to read request body", 400);
  }

  const signature = request.headers.get("X-OMI-Signature");
  const payloadShape = summarizePayloadShape(rawBody);

  logger.info("webhook:omi", "Incoming webhook received", {
    requestId,
    method: request.method,
    path: request.nextUrl.pathname,
    query: Object.fromEntries(request.nextUrl.searchParams.entries()),
    headers: summarizeHeaders(request),
    payloadShape,
    debugInspectMode,
    skipSignatureVerification,
  });

  if (debugInspectMode) {
    logger.info("webhook:omi", "Debug inspect mode accepted webhook", {
      requestId,
      payloadShape,
    });
    return successResponse(
      {
        requestId,
        inspected: true,
        payloadShape,
      },
      "Webhook inspected",
      202,
    );
  }

  if (
    !skipSignatureVerification &&
    !verifyOmiSignature(rawBody, signature, (msg) =>
      logger.warn("webhook:omi", msg, { requestId }),
    )
  ) {
    logger.warn("webhook:omi", "Invalid webhook signature", { requestId });
    return errorResponse("Invalid webhook signature", 401);
  }

  let payload: OmiWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as OmiWebhookPayload;
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  if (!payload.session_id || !Array.isArray(payload.transcript)) {
    return errorResponse("Missing required fields: session_id, transcript", 400);
  }

  const patientId = payload.patient_id;
  if (!patientId) {
    return errorResponse("patient_id is required in the webhook payload", 400);
  }

  const sessionId = payload.session_id;

  // ── Idempotency check ────────────────────────────────────────────────────
  // If OMI retries a delivery we already processed (e.g. because its ACK
  // timed out), return the existing appointment ID rather than creating a
  // duplicate record.
  const existingAppointmentId = await findAppointmentBySessionId(
    patientId,
    sessionId,
  ).catch((err) => {
    // A session-index lookup failure is non-fatal: log it and continue,
    // accepting the small risk of creating a duplicate in this edge case.
    logger.warn("webhook:omi", "Session index lookup failed — continuing", {
      requestId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (existingAppointmentId) {
    logger.info("webhook:omi", "Duplicate session detected — returning existing appointment", {
      requestId,
      sessionId,
      patientId,
      existingAppointmentId,
    });
    return successResponse(
      { appointmentId: existingAppointmentId, sessionId },
      "Already processed",
      200,
    );
  }

  // ── Build transcript text — not logged to avoid PHI in log storage ───────
  const fullTranscript = payload.transcript
    .map(
      (seg) =>
        `${seg.is_user ? "Patient" : seg.speaker || "Doctor"}: ${seg.text}`,
    )
    .join("\n");

  try {
    // Create the appointment record with status "pending" before responding.
    // If this fails, we return 500 so OMI will retry the delivery.
    const appointment = await createAppointment(
      patientId,
      {
        title: `Appointment – ${new Date(payload.started_at).toLocaleDateString()}`,
        date: payload.started_at,
        status: "pending",
      },
      sessionId,
    );

    const transcriptKey = buildS3Key(
      patientId,
      "transcripts",
      `${appointment.id}_transcript.txt`,
    );
    // Store in S3 — Railway's container filesystem is ephemeral.
    await uploadToS3(transcriptKey, fullTranscript, "text/plain", {
      category: "transcripts",
      patientId,
    });

    await updateAppointment(patientId, appointment.id, {
      transcriptS3Key: transcriptKey,
      transcriptSizeBytes: Buffer.byteLength(fullTranscript, "utf-8"),
    });

    logger.info("webhook:omi", "Webhook accepted — AI pipeline queued", {
      requestId,
      sessionId,
      appointmentId: appointment.id,
      patientId,
      segmentCount: payload.transcript.length,
    });

    // ── Schedule AI pipeline via after() ─────────────────────────────────
    // `after()` runs after the 202 response is sent. Next.js waits for it
    // during graceful shutdown (SIGTERM), so work is preserved through
    // Railway redeployments as long as they complete within the grace period.
    after(async () => {
      try {
        await processAppointment({
          patientId,
          appointmentId: appointment.id,
          transcript: fullTranscript,
          requestId,
        });
      } catch {
        // processAppointment already logged the error and updated the
        // appointment to status "error". Nothing more to do here.
      }
    });

    return successResponse(
      { appointmentId: appointment.id, sessionId },
      "Webhook received — processing in background",
      202,
    );
  } catch (error) {
    logger.error("webhook:omi", "Failed to ingest webhook", error, {
      requestId,
      sessionId,
      patientId,
    });
    return errorResponse("Failed to process webhook", 500);
  }
}
