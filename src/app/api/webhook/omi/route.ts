/**
 * POST /api/webhook/omi
 *
 * Receives audio transcript payloads from the OMI wearable device.
 * Flow:
 *  1. Validate HMAC-SHA256 signature (X-OMI-Signature header)
 *  2. Parse the transcript segments into a full text
 *  3. Store the raw transcript in S3
 *  4. Trigger Perplexity summarization
 *  5. Store the structured summary back in S3
 *  6. Index chunks into the Gemini RAG embedding store
 *  7. Return 202 immediately so OMI doesn't retry
 *
 * This route is intentionally exempt from session auth — it is verified
 * instead by HMAC-SHA256 signature using OMI_WEBHOOK_SECRET.
 */

import { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { buildS3Key, uploadToS3 } from "@/lib/s3";
import { summarizeAppointmentTranscript } from "@/lib/perplexity";
import { indexAppointment } from "@/lib/gemini";
import { createAppointment, updateAppointment } from "@/lib/appointments";
import { successResponse, errorResponse, getRequestId } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";
import type { OmiWebhookPayload } from "@/types";

// ─── Signature verification ───────────────────────────────────────────────────

function verifyOmiSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  // Read the secret directly from process.env here to avoid triggering full
  // env validation (which requires all env vars) during a health-check or cold
  // start before secrets are loaded in development. The webhook handler itself
  // is the only consumer of this secret.
  const secret = process.env.OMI_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      // Missing secret in production is a mis-configuration — reject all requests.
      logger.warn(
        "webhook:omi",
        "OMI_WEBHOOK_SECRET is not set — rejecting request in production",
      );
      return false;
    }
    // In development, warn and allow through for easier local testing.
    logger.warn(
      "webhook:omi",
      "OMI_WEBHOOK_SECRET is not set — skipping signature verification (dev only)",
    );
    return true;
  }

  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")}`;

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    return errorResponse("Failed to read request body", 400);
  }

  const signature = request.headers.get("X-OMI-Signature");
  if (!verifyOmiSignature(rawBody, signature)) {
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

  // Build full transcript text from segments — do not log the text itself.
  const fullTranscript = payload.transcript
    .map(
      (seg) =>
        `${seg.is_user ? "Patient" : seg.speaker || "Doctor"}: ${seg.text}`,
    )
    .join("\n");

  try {
    const appointment = await createAppointment(patientId, {
      title: `Appointment – ${new Date(payload.started_at).toLocaleDateString()}`,
      date: payload.started_at,
      status: "pending",
    });

    const transcriptKey = buildS3Key(
      patientId,
      "transcripts",
      `${appointment.id}_transcript.txt`,
    );
    await uploadToS3(transcriptKey, fullTranscript, "text/plain");

    await updateAppointment(patientId, appointment.id, {
      transcriptS3Key: transcriptKey,
    });

    logger.info("webhook:omi", "Webhook received — processing in background", {
      requestId,
      sessionId: payload.session_id,
      appointmentId: appointment.id,
      patientId,
      segmentCount: payload.transcript.length,
    });

    // Background processing: summarize + index (non-blocking).
    setImmediate(async () => {
      try {
        const summaryData =
          await summarizeAppointmentTranscript(fullTranscript);

        const summaryKey = buildS3Key(
          patientId,
          "summaries",
          `${appointment.id}_summary.json`,
        );
        await uploadToS3(summaryKey, JSON.stringify(summaryData, null, 2));

        await updateAppointment(patientId, appointment.id, {
          rawTranscript: fullTranscript,
          summary: summaryData.summary,
          keyPoints: summaryData.keyPoints,
          prescriptions: summaryData.prescriptions,
          followUps: summaryData.followUps,
          summaryS3Key: summaryKey,
          status: "summarized",
        });

        const indexText = `${summaryData.summary}\n\n${fullTranscript}`;
        await indexAppointment(patientId, appointment.id, indexText);

        await updateAppointment(patientId, appointment.id, {
          embeddingS3Key: buildS3Key(
            patientId,
            "embeddings",
            "embedding_index.json",
          ),
        });

        logger.info("webhook:omi", "Background processing complete", {
          appointmentId: appointment.id,
          patientId,
        });
      } catch (bgError) {
        logger.error(
          "webhook:omi:background",
          "Background processing failed",
          bgError,
          { appointmentId: appointment.id, patientId },
        );
        await updateAppointment(patientId, appointment.id, {
          status: "error",
        }).catch((e) =>
          logger.error(
            "webhook:omi:background",
            "Failed to mark appointment as error",
            e,
            { appointmentId: appointment.id },
          ),
        );
      }
    });

    return successResponse(
      { appointmentId: appointment.id, sessionId: payload.session_id },
      "Webhook received — processing in background",
      202,
    );
  } catch (error) {
    logger.error("webhook:omi", "Failed to process webhook", error, {
      requestId,
      sessionId: payload.session_id,
      patientId,
    });
    return errorResponse("Failed to process webhook", 500);
  }
}
