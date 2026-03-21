/**
 * GET /api/auth/me
 * Return the current authenticated patient's profile.
 */

import { NextRequest } from "next/server";
import { getUserById } from "@/lib/users";
import {
  requireAuth,
  successResponse,
  errorResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

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
    logger.error("auth:me", "Failed to fetch current user", error, {
      requestId,
      userId: user.sub,
    });
    return errorResponse("Internal server error", 500);
  }
}
