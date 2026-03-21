/**
 * GET /api/auth/me
 * Return the current authenticated patient's profile.
 */

import { NextRequest } from "next/server";
import { getUserById } from "@/lib/users";
import { requireAuth, successResponse, errorResponse } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;

  const { user } = authResult;

  try {
    const patient = await getUserById(user.sub);
    if (!patient) return errorResponse("Patient not found", 404);

    return successResponse(patient);
  } catch (error) {
    console.error("[me]", error);
    return errorResponse("Internal server error", 500);
  }
}
