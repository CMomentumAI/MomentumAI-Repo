/**
 * POST /api/appointments/[id]/transcript
 *
 * Upload or update the raw transcript text for an appointment.
 * After upload, the caller should POST to /summarize to trigger AI processing.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { buildS3Key, uploadToS3 } from "@/lib/s3";
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

const TranscriptSchema = z.object({
  transcript: z
    .string()
    .min(10, "Transcript is too short")
    .max(100_000, "Transcript exceeds maximum size"),
});

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

    const body = await request.json();
    const parsed = TranscriptSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const { transcript } = parsed.data;

    const transcriptKey = buildS3Key(
      user.sub,
      "transcripts",
      `${id}_transcript.txt`,
    );
    await uploadToS3(transcriptKey, transcript, "text/plain");

    const updated = await updateAppointment(user.sub, id, {
      rawTranscript: transcript,
      transcriptS3Key: transcriptKey,
      status: "pending",
    });

    logger.info("appointments/:id:transcript", "Transcript uploaded", {
      requestId,
      userId: user.sub,
      appointmentId: id,
      transcriptBytes: transcript.length,
    });

    return successResponse(
      updated,
      "Transcript uploaded. POST to /summarize to process it.",
    );
  } catch (error) {
    logger.error(
      "appointments/:id:transcript",
      "Failed to upload transcript",
      error,
      { requestId, userId: user.sub, appointmentId: id },
    );
    return errorResponse("Failed to upload transcript", 500);
  }
}
