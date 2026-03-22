/**
 * GET /api/health
 *
 * Health check endpoint consumed by Railway's load balancer and healthcheck
 * probe (configured in railway.toml). Must respond within healthcheckTimeout.
 *
 * Response shape:
 *   status      "ok" | "misconfigured"
 *   service     "Momentum"
 *   timestamp   ISO-8601
 *   version     package version
 *   config      per-service readiness flags (boolean) — does NOT make
 *               network calls; only checks process.env presence.
 *
 * Railway restarts the container automatically if this endpoint does not
 * return HTTP 200 within the configured timeout window.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRequestId } from "@/lib/api-helpers";

/** Check whether critical env vars are present without calling getEnv()
 *  (which throws on missing vars and would turn a misconfiguration into a 500). */
function checkConfig() {
  return {
    auth: !!(process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET),
    storage: !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_S3_BUCKET_NAME
    ),
    ai_summarization: !!process.env.PERPLEXITY_API_KEY,
    ai_rag: !!process.env.GEMINI_API_KEY,
    ai_tts: !!process.env.ELEVENLABS_API_KEY,
    webhook: !!process.env.OMI_WEBHOOK_SECRET,
  };
}

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  const config = checkConfig();
  const allConfigured = Object.values(config).every(Boolean);

  return NextResponse.json(
    {
      status: allConfigured ? "ok" : "misconfigured",
      service: "Momentum",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? "0.1.0",
      config,
    },
    {
      // Always return 200 so Railway doesn't restart over a misconfiguration —
      // the `status` and `config` fields tell operators what's wrong.
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-ID": requestId,
      },
    },
  );
}
