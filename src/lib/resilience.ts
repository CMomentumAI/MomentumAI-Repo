/**
 * Shared resilience utilities for external AI provider calls.
 *
 * Provides typed errors, exponential-backoff retry, and timeout helpers
 * used by all three AI providers: Perplexity, Gemini, and ElevenLabs.
 *
 * Keeping these utilities in one place means consistent retry semantics and
 * error classification across the whole pipeline.
 */

// ─── Typed provider error ─────────────────────────────────────────────────────

export type ExternalApiErrorCode =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "AUTH_ERROR"
  | "PROVIDER_ERROR"
  | "CONFIGURATION_ERROR";

/**
 * Structured error thrown by external AI provider calls.
 *
 * `isRetryable` signals whether the caller should attempt another try.
 * Raw API response bodies are intentionally excluded from the message
 * to avoid leaking prompt content or provider-side debug data into logs.
 */
export class ExternalApiError extends Error {
  constructor(
    message: string,
    public readonly code: ExternalApiErrorCode,
    public readonly provider: string,
    public readonly httpStatus?: number,
    public readonly isRetryable = false,
  ) {
    super(message);
    this.name = "ExternalApiError";
  }
}

/**
 * Map an HTTP status code to a typed code and retryability flag.
 * Centralised here so all providers use identical semantics.
 */
export function classifyHttpStatus(status: number): {
  code: ExternalApiErrorCode;
  isRetryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { code: "AUTH_ERROR", isRetryable: false };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", isRetryable: true };
  }
  if (status === 400 || status === 422) {
    return { code: "PROVIDER_ERROR", isRetryable: false };
  }
  if (status >= 500) {
    // 502/503/504 are almost always transient; 500 may or may not be.
    return {
      code: "UNAVAILABLE",
      isRetryable: status === 502 || status === 503 || status === 504,
    };
  }
  return { code: "PROVIDER_ERROR", isRetryable: false };
}

// ─── Retry ────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts including the first try. */
  attempts: number;
  /** Base inter-attempt delay in ms; doubles on each retry. */
  baseDelayMs: number;
  /** Hard cap on inter-attempt delay. */
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute `fn`, retrying when `shouldRetry(err)` returns true.
 * Uses exponential backoff with ±20 % jitter to spread load after a
 * provider-side incident.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.attempts || !shouldRetry(err)) throw err;
      const base = Math.min(
        opts.baseDelayMs * 2 ** (attempt - 1),
        opts.maxDelayMs,
      );
      const jitter = base * 0.2 * (Math.random() * 2 - 1);
      await sleep(Math.round(base + jitter));
    }
  }
  throw lastErr;
}

/**
 * Returns true for errors that are safe to retry:
 *  - ExternalApiError with isRetryable = true
 *  - Network-level TypeError (DNS failure, connection refused, etc.)
 *  - AbortError / TimeoutError (the next attempt gets a fresh timeout)
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ExternalApiError) return err.isRetryable;
  if (err instanceof TypeError) return true;
  const name = (err as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError";
}

// ─── Timeout helpers ──────────────────────────────────────────────────────────

/**
 * Create an AbortSignal that fires after `ms` milliseconds.
 * Pass as `signal` to `fetch()` to get a hard HTTP-level timeout.
 * Available in Node.js 17.3+ (Cloud Run uses Node 20).
 */
export function makeTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Race a promise against a rejection after `ms` milliseconds.
 *
 * Use this when the underlying SDK does not expose an AbortSignal interface
 * (e.g. Google Generative AI SDK). Note that the underlying HTTP request is
 * NOT cancelled — it runs to completion in the background, consuming quota.
 * Prefer `makeTimeoutSignal` + `fetch(..., { signal })` when possible.
 */
export function withTimeoutPromise<T>(
  promise: Promise<T>,
  ms: number,
  provider: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ExternalApiError(
            `${provider} call timed out after ${ms} ms`,
            "TIMEOUT",
            provider,
            undefined,
            true,
          ),
        ),
      ms,
    );
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}
