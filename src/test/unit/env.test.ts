/**
 * Tests for environment variable validation via getEnv().
 *
 * getEnv() is a singleton — each test that changes process.env must call
 * resetEnvCache() first so the singleton re-reads and re-validates.
 *
 * Tests restore the original env vars in afterEach to avoid polluting
 * subsequent tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, resetEnvCache } from "@/lib/env";

/** Snapshot the current test env so we can restore it after each test. */
const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  // Remove keys that weren't in the original env
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  // Restore original values
  Object.assign(process.env, ORIGINAL_ENV);
  resetEnvCache();
}

beforeEach(() => {
  resetEnvCache();
});

afterEach(() => {
  restoreEnv();
});

describe("getEnv() — valid configuration", () => {
  it("returns a validated config object when all required vars are set", () => {
    const env = getEnv();
    expect(env.AWS_S3_BUCKET_NAME).toBe("test-bucket");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.NODE_ENV).toBe("test");
  });

  it("accepts JWT_SECRET alone (without NEXTAUTH_SECRET)", () => {
    delete process.env.NEXTAUTH_SECRET;
    resetEnvCache();
    const env = getEnv();
    expect(env.JWT_SECRET).toBeTruthy();
  });

  it("accepts NEXTAUTH_SECRET alone (without JWT_SECRET)", () => {
    delete process.env.JWT_SECRET;
    process.env.NEXTAUTH_SECRET = "nextauth-secret-32-chars-exactly!!";
    resetEnvCache();
    const env = getEnv();
    expect(env.NEXTAUTH_SECRET).toBeTruthy();
  });

  it("defaults AWS_REGION to us-east-1 when not set", () => {
    delete process.env.AWS_REGION;
    resetEnvCache();
    const env = getEnv();
    expect(env.AWS_REGION).toBe("us-east-1");
  });
});

describe("getEnv() — missing or invalid vars", () => {
  it("throws a descriptive error when AWS_S3_BUCKET_NAME is missing", () => {
    delete process.env.AWS_S3_BUCKET_NAME;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/AWS_S3_BUCKET_NAME/);
  });

  it("throws when both JWT_SECRET and NEXTAUTH_SECRET are absent", () => {
    delete process.env.JWT_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/JWT_SECRET/);
  });

  it("throws when JWT_SECRET is shorter than 32 characters", () => {
    process.env.JWT_SECRET = "too-short";
    delete process.env.NEXTAUTH_SECRET;
    resetEnvCache();
    expect(() => getEnv()).toThrow();
  });

  it("throws when PERPLEXITY_API_KEY is missing", () => {
    delete process.env.PERPLEXITY_API_KEY;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/PERPLEXITY_API_KEY/);
  });

  it("throws when GEMINI_API_KEY is missing", () => {
    delete process.env.GEMINI_API_KEY;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/GEMINI_API_KEY/);
  });

  it("throws when OMI_WEBHOOK_SECRET is missing", () => {
    delete process.env.OMI_WEBHOOK_SECRET;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/OMI_WEBHOOK_SECRET/);
  });
});

describe("getEnv() — singleton caching", () => {
  it("returns the same object on repeated calls (cached)", () => {
    const first = getEnv();
    const second = getEnv();
    expect(first).toBe(second); // strict reference equality
  });

  it("re-validates after resetEnvCache()", () => {
    getEnv(); // prime the cache
    resetEnvCache();
    // Should not throw — env is still valid
    expect(() => getEnv()).not.toThrow();
  });
});
