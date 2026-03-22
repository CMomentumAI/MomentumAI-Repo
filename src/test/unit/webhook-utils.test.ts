/**
 * Tests for OMI webhook signature verification.
 *
 * verifyOmiSignature is a pure function (crypto + process.env) — no HTTP
 * server, no S3, no external calls needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  verifyOmiSignature,
  computeOmiSignature,
} from "@/lib/webhook-utils";

const TEST_SECRET = "test-webhook-secret-32-chars-ok!";
const SAMPLE_BODY = JSON.stringify({ session_id: "s1", transcript: [] });

function makeSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyOmiSignature", () => {
  const originalSecret = process.env.OMI_WEBHOOK_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.OMI_WEBHOOK_SECRET = TEST_SECRET;
    process.env.NODE_ENV = "test";
  });
  afterEach(() => {
    process.env.OMI_WEBHOOK_SECRET = originalSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns true for a valid HMAC-SHA256 signature", () => {
    const sig = makeSignature(SAMPLE_BODY, TEST_SECRET);
    expect(verifyOmiSignature(SAMPLE_BODY, sig)).toBe(true);
  });

  it("returns false for an incorrect secret", () => {
    const sig = makeSignature(SAMPLE_BODY, "wrong-secret");
    expect(verifyOmiSignature(SAMPLE_BODY, sig)).toBe(false);
  });

  it("returns false when the signature header is null", () => {
    expect(verifyOmiSignature(SAMPLE_BODY, null)).toBe(false);
  });

  it("returns false when the signature header is an empty string", () => {
    expect(verifyOmiSignature(SAMPLE_BODY, "")).toBe(false);
  });

  it("returns false when the body has been modified after signing", () => {
    const sig = makeSignature(SAMPLE_BODY, TEST_SECRET);
    const tamperedBody = SAMPLE_BODY + " extra";
    expect(verifyOmiSignature(tamperedBody, sig)).toBe(false);
  });

  it("returns false when the signature prefix is wrong", () => {
    const hexHash = createHmac("sha256", TEST_SECRET)
      .update(SAMPLE_BODY, "utf8")
      .digest("hex");
    // Missing "sha256=" prefix
    expect(verifyOmiSignature(SAMPLE_BODY, hexHash)).toBe(false);
  });

  describe("when OMI_WEBHOOK_SECRET is not set", () => {
    beforeEach(() => {
      delete process.env.OMI_WEBHOOK_SECRET;
    });

    it("rejects all requests in production", () => {
      process.env.NODE_ENV = "production";
      const sig = makeSignature(SAMPLE_BODY, TEST_SECRET);
      const warnings: string[] = [];
      expect(
        verifyOmiSignature(SAMPLE_BODY, sig, (msg) => warnings.push(msg)),
      ).toBe(false);
    });

    it("allows requests through in development with a warning", () => {
      process.env.NODE_ENV = "development";
      const warnings: string[] = [];
      expect(
        verifyOmiSignature(SAMPLE_BODY, null, (msg) => warnings.push(msg)),
      ).toBe(true);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("allows requests through in test mode with a warning", () => {
      process.env.NODE_ENV = "test";
      const warnings: string[] = [];
      expect(
        verifyOmiSignature(SAMPLE_BODY, null, (msg) => warnings.push(msg)),
      ).toBe(true);
    });
  });
});

// ─── computeOmiSignature ──────────────────────────────────────────────────────

describe("computeOmiSignature", () => {
  it("produces a sha256= prefixed hex HMAC", () => {
    const sig = computeOmiSignature(SAMPLE_BODY, TEST_SECRET);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("matches what verifyOmiSignature accepts", () => {
    process.env.OMI_WEBHOOK_SECRET = TEST_SECRET;
    const sig = computeOmiSignature(SAMPLE_BODY, TEST_SECRET);
    expect(verifyOmiSignature(SAMPLE_BODY, sig)).toBe(true);
    delete process.env.OMI_WEBHOOK_SECRET;
  });

  it("produces different signatures for different secrets", () => {
    const sig1 = computeOmiSignature(SAMPLE_BODY, "secret-one-32-characters-exactly!");
    const sig2 = computeOmiSignature(SAMPLE_BODY, "secret-two-32-characters-exactly!");
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different bodies", () => {
    const sig1 = computeOmiSignature('{"a":1}', TEST_SECRET);
    const sig2 = computeOmiSignature('{"a":2}', TEST_SECRET);
    expect(sig1).not.toBe(sig2);
  });
});
