/**
 * AI processing pipeline — orchestrates Perplexity summarization followed by
 * Gemini RAG indexing for a single appointment.
 *
 * This module is the single authoritative place that runs the
 * summarize → store → index → update flow. Both the webhook handler (via
 * Next.js `after()`) and the manual /summarize route call this function,
 * ensuring identical semantics regardless of trigger path.
 *
 * RAILWAY BACKGROUND WORK NOTE:
 * The webhook calls processAppointment inside Next.js `after()`, which is the
 * framework-managed post-response hook for Node.js / Docker deployments. Unlike
 * `setImmediate`, `after()` participates in Next.js's graceful-shutdown
 * sequence — when Railway sends SIGTERM the runtime will wait for pending
 * `after()` callbacks to settle before exiting, substantially reducing the
 * chance of lost work during deployments.
 *
 * Remaining limitation: a hard SIGKILL (sent after Railway's grace period)
 * will still interrupt in-progress work. The appointment's `status` stays
 * "pending" in this case and can be recovered by POSTing to
 * /api/appointments/[id]/summarize.
 */

import { buildS3Key, uploadToS3 } from "./s3";
import { summarizeAppointmentTranscript } from "./perplexity";
import { indexAppointment } from "./gemini";
import { updateAppointment } from "./appointments";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProcessingContext {
  patientId: string;
  appointmentId: string;
  /** Full transcript text. Never logged — caller is responsible for not leaking it. */
  transcript: string;
  /** Optional request correlation ID for log tracing. */
  requestId?: string;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Run the full AI processing pipeline for one appointment:
 *  1. Mark appointment as processing (write processingStartedAt)
 *  2. Call Perplexity to summarize the transcript
 *  3. Store the summary JSON in S3
 *  4. Call Gemini to embed the text and update the RAG index
 *  5. Write all results + processingCompletedAt back to the appointment record
 *
 * On any failure:
 *  - Sets status = "error", processingFailedAt, processingError (sanitized)
 *  - Re-throws so the caller (after() or route handler) can decide whether
 *    to log or surface the error further.
 *
 * Processing metadata written to the appointment record:
 *  - processingStartedAt / processingCompletedAt / processingFailedAt
 *  - processingModel — the Perplexity model identifier that produced the summary
 *  - processingError — sanitized failure reason, max 500 chars, no PHI
 */
export async function processAppointment(
  ctx: ProcessingContext,
): Promise<void> {
  const { patientId, appointmentId, transcript, requestId } = ctx;
  const logMeta = { patientId, appointmentId, requestId };

  await updateAppointment(patientId, appointmentId, {
    processingStartedAt: new Date().toISOString(),
    processingError: undefined,
  });

  try {
    logger.info("ai-pipeline", "Summarization started", logMeta);

    const summaryData = await summarizeAppointmentTranscript(transcript);

    const summaryPayload = JSON.stringify(summaryData, null, 2);
    const summarySizeBytes = Buffer.byteLength(summaryPayload, "utf-8");

    const summaryKey = buildS3Key(
      patientId,
      "summaries",
      `${appointmentId}_summary.json`,
    );
    await uploadToS3(summaryKey, summaryPayload, "application/json", {
      category: "summaries",
      patientId,
    });

    logger.info("ai-pipeline", "Summary stored — starting RAG indexing", logMeta);

    // Combine summary + transcript for richer RAG context.
    const indexText = `${summaryData.summary}\n\n${transcript}`;
    await indexAppointment(patientId, appointmentId, indexText);

    const embeddingKey = buildS3Key(
      patientId,
      "embeddings",
      "embedding_index.json",
    );

    await updateAppointment(patientId, appointmentId, {
      summary: summaryData.summary,
      keyPoints: summaryData.keyPoints,
      prescriptions: summaryData.prescriptions,
      followUps: summaryData.followUps,
      summaryS3Key: summaryKey,
      summarySizeBytes,
      embeddingS3Key: embeddingKey,
      processingModel: summaryData.model,
      processingCompletedAt: new Date().toISOString(),
      processingFailedAt: undefined,
      processingError: undefined,
      status: "summarized",
    });

    logger.info("ai-pipeline", "Pipeline complete", {
      ...logMeta,
      model: summaryData.model,
      summaryBytes: summarySizeBytes,
    });
  } catch (err) {
    // Sanitize the error message before persisting — it must not contain
    // transcript content, API keys, or any PHI.
    const rawReason = err instanceof Error ? err.message : String(err);
    const sanitizedReason = rawReason.slice(0, 500);

    logger.error("ai-pipeline", "Pipeline failed", err, logMeta);

    await updateAppointment(patientId, appointmentId, {
      status: "error",
      processingFailedAt: new Date().toISOString(),
      processingError: sanitizedReason,
    }).catch((updateErr) =>
      logger.error(
        "ai-pipeline",
        "Failed to persist error status on appointment",
        updateErr,
        logMeta,
      ),
    );

    throw err;
  }
}
