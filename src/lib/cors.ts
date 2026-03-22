/**
 * Cross-Origin Resource Sharing (CORS) for the Momentum API.
 *
 * ─── Deployment model ─────────────────────────────────────────────────────────
 * Frontend: Vercel  (e.g. https://momentum.vercel.app)
 * Backend:  Cloud Run (e.g. https://momentum-api-xxxx-uc.a.run.app)
 *
 * Every browser fetch from the Vercel frontend to the Cloud Run backend crosses
 * an origin boundary. Without explicit CORS permission the browser blocks the
 * response before JavaScript can read it, regardless of whether the HTTP
 * request itself succeeded on the server.
 *
 * ─── Configuration ────────────────────────────────────────────────────────────
 * CORS_ALLOWED_ORIGINS  (optional, comma-separated)
 *   The exact origins that are permitted to call this API from a browser.
 *   Example: "https://momentum.vercel.app,https://momentum-pr-42.vercel.app"
 *   Local dev origins (localhost 3000/3001/5173) are always included so
 *   developers need no extra configuration to get started.
 *
 * CORS_ALLOW_CREDENTIALS  (optional, "true" | "false", default "false")
 *   When "true", sets Access-Control-Allow-Credentials: true on every CORS
 *   response. Only needed when the frontend uses cookies or HTTP auth instead
 *   of (or in addition to) Bearer tokens.
 *   ⚠ When credentials are enabled, fetch() calls must use:
 *       credentials: "include"
 *   ⚠ Never used with wildcard origins — this implementation always echoes
 *     the exact request origin, so it is safe to enable credentials.
 *
 * ─── Auth model ───────────────────────────────────────────────────────────────
 * Default auth is stateless Bearer JWT.  CORS_ALLOW_CREDENTIALS defaults to
 * "false" because Bearer tokens require no credentials mode. Set it to "true"
 * if you add cookie-based auth in the future.
 *
 * ─── Webhook exception ────────────────────────────────────────────────────────
 * /api/webhook/omi is called server-to-server (OMI device → Cloud Run). It
 * receives the same CORS headers as every other route (the same proxy applies
 * to all /api/**) but is protected independently by HMAC-SHA256 signature
 * verification and does not rely on CORS for security.
 */

/** Headers the browser is allowed to send in cross-origin requests. */
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "X-Requested-With",
  "X-Request-ID",
].join(", ");

/** Methods the browser is allowed to use in cross-origin requests. */
export const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/**
 * How long (seconds) browsers may cache a CORS preflight result.
 * 2 hours balances reducing preflight overhead with timely config
 * updates after an allowlist change.
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
 *   - hardcoded dev origins (always present, regardless of NODE_ENV)
 *   - CORS_ALLOWED_ORIGINS — comma-separated list of production / preview origins
 *
 * Reads from process.env on every call so that changes to env vars are picked
 * up without a restart in development.
 */
export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(DEV_ORIGINS);

  const raw = process.env.CORS_ALLOWED_ORIGINS ?? "";
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed) origins.add(trimmed);
  }

  return origins;
}

/**
 * Returns true when the given Origin string is in the allowed list.
 * An empty string (no Origin header) is never allowed.
 */
export function isOriginAllowed(origin: string): boolean {
  if (!origin) return false;
  return getAllowedOrigins().has(origin);
}

/**
 * Returns true when CORS_ALLOW_CREDENTIALS is set to "true".
 *
 * When true, Access-Control-Allow-Credentials: true is added to every CORS
 * response. The frontend must also send fetch() with credentials: "include".
 * This is only needed when the app uses cookies or HTTP authentication
 * alongside (or instead of) Bearer tokens.
 */
export function isCorsCredentialsEnabled(): boolean {
  return (process.env.CORS_ALLOW_CREDENTIALS ?? "").toLowerCase() === "true";
}

/**
 * Returns the CORS headers to attach to a normal (non-preflight) API response.
 *
 * The origin string is always explicit — never "*". Using an exact origin
 * prevents any unlisted website from reading the response (defence in depth)
 * and is required when Access-Control-Allow-Credentials is true.
 *
 * Vary: Origin tells downstream caches (CDN, reverse proxy) to store separate
 * cached entries per origin. Without it a cache could serve one origin's CORS
 * headers to a request from a different origin.
 */
export function buildCorsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
  if (isCorsCredentialsEnabled()) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

/**
 * Returns the full set of headers for an OPTIONS preflight response.
 * Extends buildCorsHeaders with the method/header allowlists and max-age.
 */
export function buildPreflightHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
    Vary: "Origin",
  };
  if (isCorsCredentialsEnabled()) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}
