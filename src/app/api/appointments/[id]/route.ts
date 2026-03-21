/**
 * GET    /api/appointments/[id]   — fetch a single appointment
 * PATCH  /api/appointments/[id]   — update appointment fields
 * DELETE /api/appointments/[id]   — delete appointment
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getAppointment,
  updateAppointment,
  deleteAppointment,
} from "@/lib/appointments";
import {
  requireAuth,
  requireOwnership,
  successResponse,
  errorResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

type RouteContext = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  doctorName: z.string().max(100).optional(),
  specialty: z.string().max(100).optional(),
  date: z.string().datetime().optional(),
  notes: z.string().optional(),
});

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

    return successResponse(appointment);
  } catch (error) {
    logger.error("appointments/:id:GET", "Failed to fetch appointment", error, {
      requestId,
      userId: user.sub,
      appointmentId: id,
    });
    return errorResponse("Failed to fetch appointment", 500);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  const { id } = await params;

  try {
    const existing = await getAppointment(user.sub, id);
    if (!existing) return errorResponse("Appointment not found", 404);

    const ownership = requireOwnership(user, existing.patientId);
    if (ownership) return ownership;

    const body = await request.json();
    const parsed = PatchSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const updated = await updateAppointment(user.sub, id, parsed.data);
    return successResponse(updated);
  } catch (error) {
    logger.error(
      "appointments/:id:PATCH",
      "Failed to update appointment",
      error,
      { requestId, userId: user.sub, appointmentId: id },
    );
    return errorResponse("Failed to update appointment", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  const { id } = await params;

  try {
    const existing = await getAppointment(user.sub, id);
    if (!existing) return errorResponse("Appointment not found", 404);

    const ownership = requireOwnership(user, existing.patientId);
    if (ownership) return ownership;

    await deleteAppointment(user.sub, id);

    logger.info("appointments/:id:DELETE", "Appointment deleted", {
      requestId,
      userId: user.sub,
      appointmentId: id,
    });

    return successResponse(null, "Appointment deleted");
  } catch (error) {
    logger.error(
      "appointments/:id:DELETE",
      "Failed to delete appointment",
      error,
      { requestId, userId: user.sub, appointmentId: id },
    );
    return errorResponse("Failed to delete appointment", 500);
  }
}
