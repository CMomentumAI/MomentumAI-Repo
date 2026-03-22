import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExternalApiError,
  classifyHttpStatus,
  isTransientError,
  withRetry,
  withTimeoutPromise,
} from "@/lib/resilience";

// ─── classifyHttpStatus ────────────────────────────────────────────────────────

describe("classifyHttpStatus", () => {
  it.each([
    [401, "AUTH_ERROR", false],
    [403, "AUTH_ERROR", false],
    [400, "PROVIDER_ERROR", false],
    [422, "PROVIDER_ERROR", false],
    [429, "RATE_LIMITED", true],
    [500, "UNAVAILABLE", false],
    [502, "UNAVAILABLE", true],
    [503, "UNAVAILABLE", true],
    [504, "UNAVAILABLE", true],
    [200, "PROVIDER_ERROR", false], // unexpected 2xx shouldn't happen but is classified
  ])(
    "HTTP %i → code %s, retryable %s",
    (status, expectedCode, expectedRetryable) => {
      const result = classifyHttpStatus(status);
      expect(result.code).toBe(expectedCode);
      expect(result.isRetryable).toBe(expectedRetryable);
    },
  );
});

// ─── isTransientError ─────────────────────────────────────────────────────────

describe("isTransientError", () => {
  it("returns true for a retryable ExternalApiError", () => {
    const err = new ExternalApiError("rate limited", "RATE_LIMITED", "test", 429, true);
    expect(isTransientError(err)).toBe(true);
  });

  it("returns false for a non-retryable ExternalApiError", () => {
    const err = new ExternalApiError("bad request", "PROVIDER_ERROR", "test", 400, false);
    expect(isTransientError(err)).toBe(false);
  });

  it("returns true for a network-level TypeError (fetch failure)", () => {
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("returns true for an AbortError (timeout)", () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isTransientError(abortErr)).toBe(true);
  });

  it("returns true for a TimeoutError", () => {
    const timeoutErr = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    expect(isTransientError(timeoutErr)).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isTransientError(new Error("unexpected"))).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  // Use fake timers so retry delays don't slow down the suite.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result immediately when the first call succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, () => false, {
      attempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on the second attempt", async () => {
    const transientErr = new ExternalApiError("503", "UNAVAILABLE", "test", 503, true);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce("recovered");

    const promise = withRetry(fn, isTransientError, {
      attempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });

    // Advance past the first retry delay
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all attempts", async () => {
    const transientErr = new ExternalApiError("503", "UNAVAILABLE", "test", 503, true);
    const fn = vi.fn().mockRejectedValue(transientErr);

    // Attach the .rejects handler synchronously so the rejection is
    // never "unhandled" during the async timer advance.
    const assertion = expect(
      withRetry(fn, isTransientError, {
        attempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
      }),
    ).rejects.toThrow(transientErr);

    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const authErr = new ExternalApiError("401", "AUTH_ERROR", "test", 401, false);
    const fn = vi.fn().mockRejectedValue(authErr);

    const assertion = expect(
      withRetry(fn, isTransientError, {
        attempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      }),
    ).rejects.toThrow(authErr);

    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── withTimeoutPromise ───────────────────────────────────────────────────────

describe("withTimeoutPromise", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise completes before the timeout", async () => {
    const fast = Promise.resolve("fast-result");
    const result = await withTimeoutPromise(fast, 1000, "test-provider");
    expect(result).toBe("fast-result");
  });

  it("rejects with ExternalApiError(TIMEOUT) when the promise is too slow", async () => {
    const slow = new Promise<never>(() => {
      // Never resolves
    });

    // Attach the rejection handler before advancing time so it's never "unhandled".
    const assertion = expect(
      withTimeoutPromise(slow, 500, "test-provider"),
    ).rejects.toMatchObject({
      name: "ExternalApiError",
      code: "TIMEOUT",
      provider: "test-provider",
      isRetryable: true,
    });

    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it("clears the timeout timer when the promise resolves", async () => {
    const fast = Promise.resolve("done");
    await withTimeoutPromise(fast, 10_000, "test-provider");
    // If the timer wasn't cleared, vi would still have a pending timer.
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── ExternalApiError ─────────────────────────────────────────────────────────

describe("ExternalApiError", () => {
  it("sets name, code, provider, httpStatus, isRetryable correctly", () => {
    const err = new ExternalApiError("msg", "RATE_LIMITED", "perplexity", 429, true);
    expect(err.name).toBe("ExternalApiError");
    expect(err.message).toBe("msg");
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.provider).toBe("perplexity");
    expect(err.httpStatus).toBe(429);
    expect(err.isRetryable).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("defaults isRetryable to false", () => {
    const err = new ExternalApiError("msg", "PROVIDER_ERROR", "gemini");
    expect(err.isRetryable).toBe(false);
  });
});
