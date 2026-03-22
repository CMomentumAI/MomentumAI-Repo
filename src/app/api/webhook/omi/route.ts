/**
 * POST /api/webhook/omi
 *
 * Receives real-time transcript payloads from the OMI wearable device.
 * Flow:
 *  1. Optionally validate HMAC-SHA256 signature (X-OMI-Signature header)
 *  2. Log sanitized request metadata for debugging
 *  3. Resolve patient ownership from payload.patient_id or query uid
 *  4. Acknowledge the signal without persisting transcript data
 *  5. Return quickly so OMI doesn't wait or retry
 *
 * This route is intentionally exempt from session auth — it is verified
 * instead by HMAC-SHA256 signature using OMI_WEBHOOK_SECRET.
 */

import { NextRequest } from "next/server";
import { verifyOmiSignature } from "@/lib/webhook-utils";
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

  const omiUid = resolvePatientId(payload, request);
  if (!omiUid) {
    return errorResponse("uid query param or patient_id is required", 400);
  }

  const sessionId = payload.session_id;

  // Build the transcript text for downstream signal consumers, but do not
  // persist or log the PHI payload itself.
  const fullTranscript = buildTranscriptText(segments);

  logger.info("webhook:omi", "Realtime transcript signal accepted", {
    requestId,
    sessionId,
    omiUid,
    segmentCount: segments.length,
    transcriptLength: fullTranscript.length,
  });

  return successResponse(
    {
      accepted: true,
      sessionId,
      omiUid,
      segmentCount: segments.length,
    },
    "Realtime transcript signal accepted",
    202,
  );
}
