/**
 * Shared API response helpers.
 */

import { NextResponse } from "next/server";
import { extractTokenFromHeader } from "./auth";
import type { JWTPayload } from "./auth";
import type { ApiSuccess, ApiError } from "@/types";

// ─── Response builders ────────────────────────────────────────────────────────

export function successResponse<T>(
  data: T,
  message?: string,
  status = 200,
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ success: true, data, message } as ApiSuccess<T>, {
    status,
  });
}

export function errorResponse(
  error: string,
  status = 400,
  details?: unknown,
): NextResponse<ApiError> {
  return NextResponse.json(
    { success: false, error, details } as ApiError,
    { status },
  );
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export function requireAuth(
  request: Request,
): { user: JWTPayload } | NextResponse<ApiError> {
  const authHeader = request.headers.get("Authorization");
  const user = extractTokenFromHeader(authHeader);

  if (!user) {
    return errorResponse("Unauthorized — valid Bearer token required.", 401);
  }

  return { user };
}

/**
 * Ensure the authenticated user is accessing their own data.
 * Pass the patientId from the route params; returns an error response
 * if the patientId doesn't match the token's subject.
 */
export function requireOwnership(
  user: JWTPayload,
  patientId: string,
): NextResponse<ApiError> | null {
  if (user.sub !== patientId) {
    return errorResponse("Forbidden — you may only access your own data.", 403);
  }
  return null;
}
