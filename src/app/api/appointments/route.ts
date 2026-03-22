/**
 * GET  /api/appointments        — list all appointments for the patient (paginated)
 * POST /api/appointments        — create a new appointment manually
 *
 * GET query params:
 *   page  — 1-based page number (default: 1)
 *   limit — items per page, 1–100 (default: 20)
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createAppointment, listAppointments } from "@/lib/appointments";
import {
  requireAuth,
  successResponse,
  errorResponse,
  getRequestId,
  toSafeAppointment,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

const CreateAppointmentSchema = z.object({
  title: z.string().min(1).max(200),
  doctorName: z.string().max(100).optional(),
  specialty: z.string().max(100).optional(),
  notes: z.string().max(10_000).optional(),
  date: z.string().datetime().optional(),
  // rawTranscript is accepted on creation but capped to match the dedicated
  // transcript upload endpoint's limit. Prefer uploading via /transcript.
  rawTranscript: z.string().max(100_000).optional(),
});

// z.coerce does not treat null the same as undefined — use z.preprocess to
// convert missing query params (null) to undefined so .default() fires.
const nullToUndefined = (v: unknown) => (v == null ? undefined : v);
const PaginationSchema = z.object({
  page: z.preprocess(nullToUndefined, z.coerce.number().int().min(1).default(1)),
  limit: z.preprocess(nullToUndefined, z.coerce.number().int().min(1).max(100).default(20)),
});

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;

  const { user } = authResult;

  // Parse pagination query params
  const url = new URL(request.url);
  const paginationResult = PaginationSchema.safeParse({
    page: url.searchParams.get("page"),
    limit: url.searchParams.get("limit"),
  });

  if (!paginationResult.success) {
    return errorResponse(
      "Invalid pagination parameters",
      400,
      paginationResult.error.flatten().fieldErrors,
    );
  }

  const { page, limit } = paginationResult.data;

  try {
    // listAppointments returns all appointments sorted by date desc.
    // Pagination is applied in memory — acceptable for S3-backed storage
    // where all records must be loaded to sort by date anyway.
    const all = await listAppointments(user.sub);

    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const clampedPage = Math.min(page, pages);
    const offset = (clampedPage - 1) * limit;
    const slice = all.slice(offset, offset + limit);

    return successResponse({
      items: slice.map(toSafeAppointment),
      pagination: {
        total,
        page: clampedPage,
        limit,
        pages,
        hasNext: clampedPage < pages,
        hasPrev: clampedPage > 1,
      },
    });
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

    return successResponse(toSafeAppointment(appointment), "Appointment created", 201);
  } catch (error) {
    logger.error("appointments:POST", "Failed to create appointment", error, {
      requestId,
      userId: user.sub,
    });
    return errorResponse("Failed to create appointment", 500);
  }
}
