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
} from "@/lib/api-helpers";

type RouteContext = { params: Promise<{ id: string }> };

const TranscriptSchema = z.object({
  transcript: z
    .string()
    .min(10, "Transcript is too short")
    .max(100_000, "Transcript exceeds maximum size"),
});

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

    // Store in S3
    const transcriptKey = buildS3Key(
      user.sub,
      "transcripts",
      `${id}_transcript.txt`,
    );
    await uploadToS3(transcriptKey, transcript, "text/plain");

    // Update appointment record
    const updated = await updateAppointment(user.sub, id, {
      rawTranscript: transcript,
      transcriptS3Key: transcriptKey,
      status: "pending",
    });

    return successResponse(
      updated,
      "Transcript uploaded. POST to /summarize to process it.",
    );
  } catch (error) {
    console.error("[transcript:POST]", error);
    return errorResponse("Failed to upload transcript", 500);
  }
}
