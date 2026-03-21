/**
 * POST /api/appointments/[id]/summarize
 *
 * (Re-)trigger Perplexity summarization and Gemini RAG indexing
 * for a specific appointment. Useful when a transcript is added manually
 * or when the initial background processing failed.
 *
 * Summary artifacts are stored in S3 (not on local disk) because Railway's
 * container filesystem is ephemeral — files written at runtime are lost on
 * every redeploy or restart.
 */

import { NextRequest } from "next/server";
import { buildS3Key, uploadToS3 } from "@/lib/s3";
import { summarizeAppointmentTranscript } from "@/lib/perplexity";
import { indexAppointment } from "@/lib/gemini";
import { getAppointment, updateAppointment } from "@/lib/appointments";
import {
  requireAuth,
  requireOwnership,
  successResponse,
  errorResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  const { id } = await params;

  try {
    const appointment = await getAppointment(user.sub, id);
    if (!appointment) return errorResponse("Appointment not found", 404);

    const ownership = requireOwnership(user, appointment.patientId);
    if (ownership) return ownership;

    const transcript = appointment.rawTranscript;
    if (!transcript) {
      return errorResponse(
        "No transcript available. Upload a transcript first.",
        422,
      );
    }

    await updateAppointment(user.sub, id, { status: "pending" });

    const summaryData = await summarizeAppointmentTranscript(transcript);

    const summaryPayload = JSON.stringify(summaryData, null, 2);
    const summarySizeBytes = Buffer.byteLength(summaryPayload, "utf-8");

    const summaryKey = buildS3Key(
      user.sub,
      "summaries",
      `${id}_summary.json`,
    );
    // Store with category validation to enforce the 256 KB limit.
    await uploadToS3(summaryKey, summaryPayload, "application/json", {
      category: "summaries",
      patientId: user.sub,
    });

    const indexText = `${summaryData.summary}\n\n${transcript}`;
    await indexAppointment(user.sub, id, indexText);

    const updated = await updateAppointment(user.sub, id, {
      summary: summaryData.summary,
      keyPoints: summaryData.keyPoints,
      prescriptions: summaryData.prescriptions,
      followUps: summaryData.followUps,
      summaryS3Key: summaryKey,
      summarySizeBytes,
      embeddingS3Key: buildS3Key(user.sub, "embeddings", "embedding_index.json"),
      status: "summarized",
    });

    logger.info("appointments/:id:summarize", "Appointment summarized", {
      requestId,
      userId: user.sub,
      appointmentId: id,
      summaryBytes: summarySizeBytes,
    });

    return successResponse(updated, "Appointment summarized successfully");
  } catch (error) {
    logger.error(
      "appointments/:id:summarize",
      "Summarization failed",
      error,
      { requestId, userId: user.sub, appointmentId: id },
    );

    await updateAppointment(user.sub, id, { status: "error" }).catch((e) =>
      logger.error(
        "appointments/:id:summarize",
        "Failed to mark appointment as error",
        e,
        { requestId, appointmentId: id },
      ),
    );

    return errorResponse("Failed to summarize appointment", 500);
  }
}
