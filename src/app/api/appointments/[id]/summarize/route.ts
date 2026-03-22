/**
 * POST /api/appointments/[id]/summarize
 *
 * (Re-)trigger AI summarization and Gemini RAG indexing for an appointment.
 * Useful when:
 *  - A transcript was uploaded manually via /transcript
 *  - The initial webhook-triggered background processing failed (status="error")
 *  - The appointment was left in status="pending" after a Railway restart
 *
 * This route runs the pipeline synchronously and waits for it to complete
 * before responding, so the caller immediately receives the updated appointment.
 * The shared processAppointment() helper ensures identical semantics to the
 * webhook's after() path.
 *
 * Summary artifacts are stored in S3 (not local disk) because Railway's
 * container filesystem is ephemeral — files written at runtime are lost on
 * every redeploy or restart.
 */

import { NextRequest } from "next/server";
import { getAppointment } from "@/lib/appointments";
import { processAppointment } from "@/lib/ai-pipeline";
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

    // Run the full summarize → store → index pipeline synchronously.
    // processAppointment writes processingStartedAt before the AI calls and
    // updates status + processingCompletedAt (or processingFailedAt) on completion.
    await processAppointment({
      patientId: user.sub,
      appointmentId: id,
      transcript,
      requestId,
    });

    // Re-fetch the appointment to get the latest state written by processAppointment.
    const updated = await getAppointment(user.sub, id);

    logger.info("appointments/:id:summarize", "Summarization complete", {
      requestId,
      userId: user.sub,
      appointmentId: id,
    });

    return successResponse(updated, "Appointment summarized successfully");
  } catch (error) {
    // processAppointment already updated status to "error" and logged the
    // failure — we just need to return an appropriate HTTP error here.
    logger.error(
      "appointments/:id:summarize",
      "Summarization request failed",
      error,
      { requestId, userId: user.sub, appointmentId: id },
    );
    return errorResponse("Failed to summarize appointment", 500);
  }
}
