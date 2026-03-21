/**
 * GET /api/health
 * Health check endpoint for Railway / load balancer probes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRequestId } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);

  return NextResponse.json(
    {
      status: "ok",
      service: "Momentum",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? "0.1.0",
    },
    {
      headers: {
        // Health checks must never be cached — stale 200s from a CDN or proxy
        // would hide an unhealthy instance from load-balancer checks.
        "Cache-Control": "no-store",
        "X-Request-ID": requestId,
      },
    },
  );
}
