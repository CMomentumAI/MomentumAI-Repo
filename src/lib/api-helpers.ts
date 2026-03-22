/**
 * Shared API response helpers and route-level auth guards.
 */

import { NextResponse } from "next/server";
import { extractTokenFromHeader } from "./auth";
import type { JWTPayload } from "./auth";
import { isTokenDenied } from "./token-denylist";
import type { ApiSuccess, ApiError, Appointment, AppointmentSummaryView } from "@/types";

// ─── Request correlation ───────────────────────────────────────────────────────

/**
 * Read the correlation ID injected by the Proxy (src/proxy.ts).
 * Falls back to a placeholder so logs always have a traceable field.
 */
export function getRequestId(request: Request): string {
  return request.headers.get("X-Request-ID") ?? "no-req-id";
}

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

/**
 * Standard 429 response for rate-limited requests.
 * Sets Retry-After so well-behaved clients can back off correctly.
 */
export function rateLimitResponse(resetAt: number): NextResponse<ApiError> {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((resetAt - Date.now()) / 1000),
  );
  const response = errorResponse(
    "Too many requests — please wait before trying again.",
    429,
  );
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
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

  // Check whether this specific token has been explicitly revoked via logout.
  if (isTokenDenied(user)) {
    return errorResponse("Token has been revoked — please log in again.", 401);
  }

  return { user };
}

// ─── PHI-safe appointment view ────────────────────────────────────────────────

/**
 * Strip `rawTranscript` from an appointment before sending it to clients.
 *
 * `rawTranscript` can be up to 100 KB of PHI and must not be included in
 * list or detail API responses. Clients that need the transcript text should
 * use GET /api/appointments/:id/transcript to obtain a short-lived presigned
 * S3 download URL.
 *
 * `hasTranscript` indicates whether a transcript is available for download.
 */
export function toSafeAppointment(a: Appointment): AppointmentSummaryView {
  const { rawTranscript, ...rest } = a;
  return {
    ...rest,
    hasTranscript: rawTranscript !== undefined || !!a.transcriptS3Key,
  };
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
