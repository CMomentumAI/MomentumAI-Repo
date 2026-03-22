/**
 * Next.js Proxy (formerly Middleware — renamed in Next.js 16).
 *
 * Runs on the Node.js runtime before every matched /api/** route.
 *
 * Responsibilities:
 *
 *   1. CORS — cross-origin browser support for the Vercel frontend.
 *      The backend runs on Cloud Run; the frontend runs on Vercel. Every
 *      browser fetch crosses an origin boundary and requires explicit CORS
 *      permission. This proxy is the single centralised place where CORS is
 *      handled so route handlers stay free of boilerplate.
 *
 *      • OPTIONS preflight: browser sends this before any cross-origin request
 *        that uses a custom header (e.g. Authorization). We handle it here and
 *        return 204 immediately — the actual request follows separately.
 *      • Non-preflight: attach Access-Control-Allow-Origin + Vary: Origin to
 *        the response so the browser allows the JS code to read it.
 *      • Disallowed origins: preflights return 403; actual requests pass through
 *        without CORS headers (the browser will block them client-side).
 *
 *   2. Request correlation — generate or propagate X-Request-ID.
 *      Every request receives a UUID v4 that threads through the response and
 *      all log entries, enabling end-to-end tracing across Vercel and Cloud Run.
 *
 * Auth is NOT enforced here. Bearer JWT auth is verified per-route by
 * requireAuth(). Keeping auth out of the Proxy means route-level checks remain
 * the authoritative gate and are easy to audit independently.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import {
  isOriginAllowed,
  buildCorsHeaders,
  buildPreflightHeaders,
} from "./lib/cors";

export function proxy(request: NextRequest) {
  const origin = request.headers.get("Origin") ?? "";
  const requestId = request.headers.get("X-Request-ID")?.trim() || randomUUID();
  const originAllowed = isOriginAllowed(origin);

  // ── CORS preflight ───────────────────────────────────────────────────────────
  // Browsers send OPTIONS before every cross-origin request that uses a
  // non-simple method or a non-simple header (such as Authorization). We
  // intercept OPTIONS here so route handlers never need to handle it.
  if (request.method === "OPTIONS") {
    if (originAllowed) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          ...buildPreflightHeaders(origin),
          "X-Request-ID": requestId,
        },
      });
    }

    // Unknown origin — deny the preflight. The browser will block the actual
    // request too, but returning 403 here gives developers a clearer signal
    // than a silent connection failure.
    return new NextResponse(null, {
      status: 403,
      headers: { "X-Request-ID": requestId },
    });
  }

  // ── Pass-through: attach X-Request-ID + CORS headers ────────────────────────
  // Inject the correlation ID into the upstream request so route handlers can
  // include it in structured log entries.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("X-Request-ID", requestId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Echo the correlation ID on the response for end-to-end tracing.
  response.headers.set("X-Request-ID", requestId);

  // Attach CORS headers when the request comes from an allowed origin.
  // Without these, the browser will block the JS code from reading the response
  // even if the HTTP request itself succeeded on the server.
  if (originAllowed) {
    const corsHeaders = buildCorsHeaders(origin);
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
  }

  return response;
}

export const config = {
  // Run on all API routes. Skip Next.js internals and static assets.
  matcher: ["/api/:path*"],
};
