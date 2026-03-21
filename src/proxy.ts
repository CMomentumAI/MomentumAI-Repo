/**
 * Next.js Proxy (formerly Middleware — renamed in Next.js 16).
 *
 * Runs before every matched route on the Node.js runtime.
 * Responsibilities kept deliberately minimal:
 *
 *   1. Generate or propagate a request correlation ID (X-Request-ID).
 *      - Honour an incoming X-Request-ID if the caller supplies one so that
 *        clients that generate their own IDs can correlate end-to-end.
 *      - Otherwise generate a new UUID v4.
 *   2. Forward the ID on the request (so route handlers can read it from
 *      request.headers.get("X-Request-ID")) and on the response (so clients
 *      and load-balancer logs can correlate requests to responses).
 *
 * Auth is NOT enforced here — the app uses stateless Bearer JWTs verified
 * per-route by requireAuth(). Keeping auth out of Proxy avoids the risk of
 * accidentally bypassing a route's own checks, and keeps this file easy to
 * audit and test.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";

export function proxy(request: NextRequest) {
  const requestId =
    request.headers.get("X-Request-ID")?.trim() || randomUUID();

  // Inject the ID into the upstream request headers so route handlers can log it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("X-Request-ID", requestId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Echo the ID back to the caller for end-to-end tracing.
  response.headers.set("X-Request-ID", requestId);

  return response;
}

export const config = {
  // Run on all API routes. Skip Next.js internals and static assets.
  matcher: ["/api/:path*"],
};
