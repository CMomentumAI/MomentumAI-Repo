/**
 * GET /api/health
 *
 * Health check endpoint consumed by Cloud Run's load balancer. Cloud Run
 * considers the service healthy when this path returns HTTP 200.
 *
 * Response shape:
 *   status      "ok" | "misconfigured"
 *   service     "Momentum"
 *   timestamp   ISO-8601
 *   version     package version
 *   config      per-service readiness flags (boolean) — does NOT make
 *               network calls; only checks process.env presence.
 *
 * Always returns HTTP 200 even when misconfigured, so Cloud Run does not
 * restart the container over a missing env var. Operators read the `config`
 * object to diagnose which service group is not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRequestId } from "@/lib/api-helpers";

/** Check whether critical env vars are present without calling getEnv()
 *  (which throws on missing vars and would turn a misconfiguration into a 500). */
function checkConfig() {
  return {
    auth: !!(process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET),
    storage: !!(
      process.env.GCS_BUCKET_NAME &&
      process.env.GCS_PROJECT_ID
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
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-ID": requestId,
      },
    },
  );
}
