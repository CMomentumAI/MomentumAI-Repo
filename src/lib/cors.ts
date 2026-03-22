/**
 * Cross-Origin Resource Sharing (CORS) for the Momentum API.
 *
 * ─── Deployment model ─────────────────────────────────────────────────────────
 * Frontend: Vercel  (e.g. https://momentum.vercel.app)
 * Backend:  Railway (e.g. https://api.momentum.railway.app)
 *
 * Every browser fetch from the Vercel frontend to the Railway backend crosses
 * an origin boundary. Without explicit CORS permission the browser blocks the
 * response before JavaScript can read it, regardless of whether the request
 * succeeded on the server.
 *
 * ─── Auth model & credentials ─────────────────────────────────────────────────
 * Auth is stateless Bearer JWT. The client stores the token in memory (or
 * localStorage) and sends it as:
 *
 *   Authorization: Bearer <token>
 *
 * Cookies are NOT used. Therefore:
 *   • Access-Control-Allow-Credentials is NOT set (defaults to false)
 *   • fetch() calls do NOT need credentials: "include"
 *   • SameSite / Secure cookie settings are irrelevant
 *
 * ─── Origin allowlist ─────────────────────────────────────────────────────────
 * Origins are checked exactly (no wildcard patterns) to prevent unintended
 * PHI exposure to arbitrary third-party websites:
 *
 *   DEV_ORIGINS        — hardcoded local dev ports
 *   FRONTEND_URL       — Railway/production env var, the canonical Vercel URL
 *   ADDITIONAL_ORIGINS — comma-separated list for preview / staging deployments
 *
 * ─── Webhook exception ────────────────────────────────────────────────────────
 * /api/webhook/omi is called server-to-server (OMI device → Railway). It
 * receives the same CORS headers as every other route (the same proxy runs on
 * all /api/**) but it is protected independently by HMAC-SHA256 signature
 * verification and does not rely on CORS for security.
 */

/** Headers the browser is allowed to send in cross-origin requests. */
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Request-ID",
].join(", ");

/** Methods the browser is allowed to use in cross-origin requests. */
export const CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/**
 * How long (seconds) browsers may cache a CORS preflight result.
 * 2 hours (7200 s) balances reducing preflight overhead with timely
 * config updates after an allowlist change.
 */
export const CORS_MAX_AGE = "7200";

/** Local development origins always present in the allowlist. */
export const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173", // Vite default
];

/**
 * Returns the full set of allowed origins by combining:
 *   - hardcoded dev origins (always present)
 *   - FRONTEND_URL   — the canonical production Vercel URL
 *   - ADDITIONAL_ORIGINS — comma-separated extras for preview deployments
 *
 * Reads from process.env on every call so that changes to env vars are
 * picked up without a restart in development. The overhead is a small Set
 * construction per request, which is negligible.
 */
export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(DEV_ORIGINS);

  const frontendUrl = process.env.FRONTEND_URL?.trim();
  if (frontendUrl) origins.add(frontendUrl);

  const extra = process.env.ADDITIONAL_ORIGINS ?? "";
  for (const raw of extra.split(",")) {
    const trimmed = raw.trim();
    if (trimmed) origins.add(trimmed);
  }

  return origins;
}

/**
 * Returns true when the given Origin string is in the allowlist.
 * An empty string (request without an Origin header) is never allowed.
 */
export function isOriginAllowed(origin: string): boolean {
  if (!origin) return false;
  return getAllowedOrigins().has(origin);
}

/**
 * Returns the CORS headers to attach to a normal (non-preflight) API response.
 *
 * Only called when the origin is in the allowlist, so the origin string is
 * always explicit — never "*". Using an explicit origin prevents any other
 * website from reading the response even if the browser ignored the allowlist
 * (defence in depth).
 *
 * Vary: Origin tells downstream caches (CDN, reverse proxy) to store separate
 * cached entries per origin. Without it, a cache could serve a response with
 * one origin's CORS headers to a request from a different origin.
 */
export function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

/**
 * Returns the full set of headers for an OPTIONS preflight response.
 * Extends buildCorsHeaders with the method/header allowlists and max-age.
 */
export function buildPreflightHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
    Vary: "Origin",
  };
}
