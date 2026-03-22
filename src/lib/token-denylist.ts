/**
 * In-memory JWT token denylist for logout support.
 *
 * Tokens are keyed by `${sub}:${iat}` so a specific issued token can be
 * invalidated without affecting other tokens belonging to the same user.
 *
 * LIMITATIONS (documented intentionally):
 *  - The denylist lives in the Node.js process heap. It does NOT survive
 *    a container restart or Railway redeploy. After a restart, previously
 *    logged-out tokens will be valid again until their natural expiry.
 *  - On multi-replica deployments, logout only invalidates the token on the
 *    instance that handled the request. For shared revocation, replace this
 *    module with a Redis or Valkey-backed store.
 *  - For a hackathon/single-instance Railway deployment these limitations
 *    are acceptable; they are called out here so a production hardening pass
 *    knows exactly what to address.
 *
 * In practice, the window of concern is small: tokens expire after 7 days,
 * the denylist entries track that same expiry, and the list is self-pruning.
 */

import type { JWTPayload } from "./auth";

/** denylist key → expiry epoch-ms */
const _denylist = new Map<string, number>();

function makeKey(sub: string, iat: number): string {
  return `${sub}:${iat}`;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, expiresAt] of _denylist) {
    if (now > expiresAt) _denylist.delete(key);
  }
}

/**
 * Add a token to the denylist. Call this when the user logs out.
 * The entry is automatically removed after the token's natural expiry.
 */
export function denyToken(payload: Pick<JWTPayload, "sub" | "iat" | "exp">): void {
  const iat = payload.iat ?? 0;
  const expiresAtMs = (payload.exp ?? 0) * 1000;
  _denylist.set(makeKey(payload.sub, iat), expiresAtMs);
  // Prune opportunistically to keep the map bounded.
  if (_denylist.size > 500) pruneExpired();
}

/**
 * Returns true if the specific token has been explicitly revoked via logout.
 * Expired entries are cleaned up on hit.
 */
export function isTokenDenied(payload: Pick<JWTPayload, "sub" | "iat">): boolean {
  const key = makeKey(payload.sub, payload.iat ?? 0);
  const expiresAt = _denylist.get(key);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    _denylist.delete(key);
    return false;
  }
  return true;
}

/** @internal Only for tests — clears the entire denylist. */
export function _resetDenylistForTesting(): void {
  _denylist.clear();
}
