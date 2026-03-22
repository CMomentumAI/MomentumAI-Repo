/**
 * POST /api/webhook/omi
 *
 * Receives real-time transcript payloads from the OMI wearable device.
 * Flow:
 *  1. Optionally validate HMAC-SHA256 signature (X-OMI-Signature header)
 *  2. Log sanitized request metadata for debugging
 *  3. Resolve patient ownership from payload.patient_id or query uid
 *  4. Create or update an appointment keyed by session_id
 *  5. Store the latest transcript snapshot in S3
 *  6. Return quickly so OMI doesn't wait or retry
 *
 * This route is intentionally exempt from session auth — it is verified
 * instead by HMAC-SHA256 signature using OMI_WEBHOOK_SECRET.
 */

import { NextRequest } from "next/server";
import { buildS3Key, uploadToS3 } from "@/lib/s3";
import { verifyOmiSignature } from "@/lib/webhook-utils";
import { createAppointment, findAppointmentBySessionId, updateAppointment } from "@/lib/appointments";
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
      hasSegments: Array.isArray(payload.segments),
      segmentCount: Array.isArray(payload.segments) ? payload.segments.length : null,
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

function resolvePatientId(
  payload: OmiWebhookPayload,
  request: NextRequest,
): string | null {
  if (payload.patient_id) return payload.patient_id;
  const requestUrl =
    "nextUrl" in request && request.nextUrl instanceof URL
      ? request.nextUrl
      : new URL(request.url);
  return requestUrl.searchParams.get("uid");
}

function resolveSegments(payload: OmiWebhookPayload) {
  if (Array.isArray(payload.transcript)) {
    return payload.transcript;
  }
  if (Array.isArray(payload.segments)) {
    return payload.segments;
  }
  return null;
}

function buildTranscriptText(
  segments: NonNullable<OmiWebhookPayload["transcript"]>,
): string {
  return segments
    .map((seg) => `${seg.is_user ? "Patient" : seg.speaker || "Doctor"}: ${seg.text}`)
    .join("\n");
}

function resolveAppointmentDate(payload: OmiWebhookPayload): string {
  return payload.started_at ?? payload.finished_at ?? new Date().toISOString();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  let rawBody: string;
  const debugInspectMode = isTruthyEnv(process.env.OMI_WEBHOOK_DEBUG_MODE);
  const skipSignatureVerification = isTruthyEnv(
    process.env.OMI_SKIP_SIGNATURE_VERIFICATION,
  );
  const requestUrl =
    "nextUrl" in request && request.nextUrl instanceof URL
      ? request.nextUrl
      : new URL(request.url);

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
    path: requestUrl.pathname,
    query: Object.fromEntries(requestUrl.searchParams.entries()),
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

  const segments = resolveSegments(payload);

  if (!payload.session_id || !Array.isArray(segments)) {
    return errorResponse("Missing required fields: session_id, transcript or segments", 400);
  }

  const patientId = resolvePatientId(payload, request);
  if (!patientId) {
    return errorResponse("uid query param or patient_id is required", 400);
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
    const transcriptKey = buildS3Key(
      patientId,
      "transcripts",
      `${existingAppointmentId}_transcript.txt`,
    );
    const fullTranscript = buildTranscriptText(segments);

    await uploadToS3(transcriptKey, fullTranscript, "text/plain", {
      category: "transcripts",
      patientId,
    });

    await updateAppointment(patientId, existingAppointmentId, {
      transcriptS3Key: transcriptKey,
      transcriptSizeBytes: Buffer.byteLength(fullTranscript, "utf-8"),
      rawTranscript: fullTranscript,
      date: resolveAppointmentDate(payload),
    });

    logger.info("webhook:omi", "Duplicate session detected — returning existing appointment", {
      requestId,
      sessionId,
      patientId,
      existingAppointmentId,
      segmentCount: segments.length,
    });
    return successResponse(
      { appointmentId: existingAppointmentId, sessionId },
      "Transcript updated",
      200,
    );
  }

  // ── Build transcript text — not logged to avoid PHI in log storage ───────
  const fullTranscript = buildTranscriptText(segments);

  try {
    // Create the appointment record with status "pending" before responding.
    // If this fails, we return 500 so OMI will retry the delivery.
    const appointment = await createAppointment(
      patientId,
      {
        title: `Appointment – ${new Date(resolveAppointmentDate(payload)).toLocaleDateString()}`,
        date: resolveAppointmentDate(payload),
        rawTranscript: fullTranscript,
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
      segmentCount: segments.length,
    });

    return successResponse(
      { appointmentId: appointment.id, sessionId },
      "Webhook received",
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
