/**
 * GET /api/appointments/[id]/summary
 *
 * Returns a short-lived presigned S3 download URL for the appointment's
 * structured summary JSON. The URL expires after 5 minutes (300 s).
 *
 * The summary JSON contains the full structured output from Perplexity
 * including keyPoints, prescriptions, and followUps. For a compact view
 * of the same data, use GET /api/appointments/:id which includes the
 * `summary`, `keyPoints`, `prescriptions`, and `followUps` fields inline.
 */

import { NextRequest } from "next/server";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { getAppointment } from "@/lib/appointments";
import {
  requireAuth,
  requireOwnership,
  successResponse,
  errorResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
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

    if (!appointment.summaryS3Key) {
      return errorResponse(
        "No summary available — run POST /api/appointments/:id/summarize first",
        404,
      );
    }

    const url = await getPresignedDownloadUrl(appointment.summaryS3Key, 300);

    logger.info("appointments/:id:summary:GET", "Presigned summary URL issued", {
      requestId,
      userId: user.sub,
      appointmentId: id,
    });

    return successResponse({
      url,
      expiresInSeconds: 300,
      sizeBytes: appointment.summarySizeBytes ?? null,
      generatedAt: appointment.processingCompletedAt ?? null,
      model: appointment.processingModel ?? null,
    });
  } catch (error) {
    logger.error(
      "appointments/:id:summary:GET",
      "Failed to generate summary download URL",
      error,
      { requestId, userId: user.sub, appointmentId: id },
    );
    return errorResponse("Failed to generate download URL", 500);
  }
}
