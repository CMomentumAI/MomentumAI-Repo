/**
 * GET   /api/user/profile   — fetch current patient profile
 * PATCH /api/user/profile   — update patient profile fields
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { getUserById, updateUserProfile } from "@/lib/users";
import {
  requireAuth,
  successResponse,
  errorResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

const ProfileUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .optional(),
});

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  try {
    const patient = await getUserById(user.sub);
    if (!patient) return errorResponse("Patient not found", 404);

    return successResponse(patient);
  } catch (error) {
    logger.error("profile:GET", "Failed to fetch profile", error, {
      requestId,
      userId: user.sub,
    });
    return errorResponse("Failed to fetch profile", 500);
  }
}

export async function PATCH(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = ProfileUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const updated = await updateUserProfile(user.sub, parsed.data);
    if (!updated) return errorResponse("Patient not found", 404);

    logger.info("profile:PATCH", "Profile updated", {
      requestId,
      userId: user.sub,
    });

    return successResponse(updated, "Profile updated");
  } catch (error) {
    logger.error("profile:PATCH", "Failed to update profile", error, {
      requestId,
      userId: user.sub,
    });
    return errorResponse("Failed to update profile", 500);
  }
}
