/**
 * POST /api/appointments/[id]/summarize
 *
 * (Re-)trigger Perplexity summarization and Gemini RAG indexing
 * for a specific appointment. Useful when a transcript is added manually
 * or when the initial background processing failed.
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
} from "@/lib/api-helpers";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
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

    // Update status to pending before processing
    await updateAppointment(user.sub, id, { status: "pending" });

    // Summarize
    const summaryData = await summarizeAppointmentTranscript(transcript);

    const summaryKey = buildS3Key(
      user.sub,
      "summaries",
      `${id}_summary.json`,
    );
    await uploadToS3(summaryKey, JSON.stringify(summaryData, null, 2));

    // Index for RAG
    const indexText = `${summaryData.summary}\n\n${transcript}`;
    await indexAppointment(user.sub, id, indexText);

    // Update appointment record
    const updated = await updateAppointment(user.sub, id, {
      summary: summaryData.summary,
      keyPoints: summaryData.keyPoints,
      prescriptions: summaryData.prescriptions,
      followUps: summaryData.followUps,
      summaryS3Key: summaryKey,
      embeddingS3Key: buildS3Key(user.sub, "embeddings", "embedding_index.json"),
      status: "summarized",
    });

    return successResponse(updated, "Appointment summarized successfully");
  } catch (error) {
    console.error("[summarize:POST]", error);

    // Mark as error
    await updateAppointment(user.sub, id, { status: "error" }).catch(
      console.error,
    );

    return errorResponse("Failed to summarize appointment", 500);
  }
}
