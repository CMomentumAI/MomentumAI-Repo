/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Suitable for single-instance Railway/Docker deployments. If the app is ever
 * scaled to multiple replicas, replace the in-process store with a shared
 * counter backed by Redis or Railway's Valkey add-on.
 *
 * Usage:
 *   const result = authLimiter.check(clientIp);
 *   if (!result.allowed) return rateLimitResponse(result.resetAt);
 */

interface Window {
  count: number;
  resetAt: number; // epoch ms
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // epoch ms
}

interface RateLimiterOptions {
  /** Duration of each window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed per window per key. */
  max: number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly store = new Map<string, Window>();

  constructor({ windowMs, max }: RateLimiterOptions) {
    this.windowMs = windowMs;
    this.max = max;
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    const existing = this.store.get(key);

    if (!existing || now >= existing.resetAt) {
      const resetAt = now + this.windowMs;
      this.store.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.max - 1, resetAt };
    }

    if (existing.count >= this.max) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: this.max - existing.count,
      resetAt: existing.resetAt,
    };
  }

  /** Remove expired windows. Call periodically to prevent unbounded growth. */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, win] of this.store) {
      if (now >= win.resetAt) this.store.delete(key);
    }
  }

  /** @internal Clear all windows. Only use this in tests. */
  reset(): void {
    this.store.clear();
  }
}

/**
 * Extract the most-specific client IP from Railway's forwarded headers.
 * Railway terminates TLS and adds X-Forwarded-For. The leftmost value is the
 * original client; subsequent values are proxy hops.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  // Fallback — no forwarding header present (e.g. local dev direct connection)
  return "unknown";
}

// ─── Pre-configured limiters ──────────────────────────────────────────────────

/** Tight limit for authentication endpoints to slow credential stuffing. */
export const authLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });

/** General-purpose limit for authenticated API endpoints. */
export const apiLimiter = new RateLimiter({ windowMs: 60_000, max: 120 });

// Purge expired windows every 10 minutes to keep memory bounded.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    authLimiter.purgeExpired();
    apiLimiter.purgeExpired();
  }, 10 * 60 * 1000).unref?.();
}

/** @internal Reset all rate-limit windows. Only use this in tests. */
export function _resetRateLimitersForTesting(): void {
  authLimiter.reset();
  apiLimiter.reset();
}
