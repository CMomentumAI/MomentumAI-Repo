/**
 * GET  /api/appointments        — list all appointments for the patient
 * POST /api/appointments        — create a new appointment manually
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createAppointment, listAppointments } from "@/lib/appointments";
import {
  requireAuth,
  successResponse,
  errorResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

const CreateAppointmentSchema = z.object({
  title: z.string().min(1).max(200),
  doctorName: z.string().max(100).optional(),
  specialty: z.string().max(100).optional(),
  date: z.string().datetime().optional(),
  rawTranscript: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;

  const { user } = authResult;

  try {
    const appointments = await listAppointments(user.sub);
    return successResponse(appointments);
  } catch (error) {
    logger.error("appointments:GET", "Failed to list appointments", error, {
      requestId,
      userId: user.sub,
    });
    return errorResponse("Failed to fetch appointments", 500);
  }
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;

  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = CreateAppointmentSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const appointment = await createAppointment(user.sub, {
      ...parsed.data,
      date: parsed.data.date ?? new Date().toISOString(),
    });

    logger.info("appointments:POST", "Appointment created", {
      requestId,
      userId: user.sub,
      appointmentId: appointment.id,
    });

    return successResponse(appointment, "Appointment created", 201);
  } catch (error) {
    logger.error("appointments:POST", "Failed to create appointment", error, {
      requestId,
      userId: user.sub,
    });
    return errorResponse("Failed to create appointment", 500);
  }
}
