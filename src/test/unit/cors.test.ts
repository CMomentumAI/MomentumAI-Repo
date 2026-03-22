/**
 * Unit tests for the CORS helper (src/lib/cors.ts).
 *
 * The proxy reads process.env directly (no getEnv() call) so tests can
 * manipulate FRONTEND_URL and ADDITIONAL_ORIGINS with vi.stubEnv.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEV_ORIGINS,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  getAllowedOrigins,
  isOriginAllowed,
  buildCorsHeaders,
  buildPreflightHeaders,
} from "@/lib/cors";

// ─── getAllowedOrigins ─────────────────────────────────────────────────────────

describe("getAllowedOrigins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("always includes all hardcoded dev origins", () => {
    const origins = getAllowedOrigins();
    for (const o of DEV_ORIGINS) {
      expect(origins.has(o)).toBe(true);
    }
  });

  it("includes FRONTEND_URL when set", () => {
    vi.stubEnv("FRONTEND_URL", "https://momentum.vercel.app");
    const origins = getAllowedOrigins();
    expect(origins.has("https://momentum.vercel.app")).toBe(true);
  });

  it("does not add a blank FRONTEND_URL", () => {
    vi.stubEnv("FRONTEND_URL", "   ");
    const origins = getAllowedOrigins();
    // Only the DEV_ORIGINS should be present; a blank string must not be added.
    expect(origins.has("")).toBe(false);
    expect(origins.has("   ")).toBe(false);
  });

  it("includes comma-separated ADDITIONAL_ORIGINS", () => {
    vi.stubEnv(
      "ADDITIONAL_ORIGINS",
      "https://preview-a.vercel.app, https://preview-b.vercel.app",
    );
    const origins = getAllowedOrigins();
    expect(origins.has("https://preview-a.vercel.app")).toBe(true);
    expect(origins.has("https://preview-b.vercel.app")).toBe(true);
  });

  it("ignores empty entries in ADDITIONAL_ORIGINS (trailing comma, double comma)", () => {
    vi.stubEnv("ADDITIONAL_ORIGINS", "https://preview.vercel.app,,");
    const origins = getAllowedOrigins();
    expect(origins.has("https://preview.vercel.app")).toBe(true);
    // empty strings and pure-whitespace entries must not appear
    expect(origins.has("")).toBe(false);
  });
});

// ─── isOriginAllowed ──────────────────────────────────────────────────────────

describe("isOriginAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows a known dev origin", () => {
    expect(isOriginAllowed("http://localhost:3000")).toBe(true);
    expect(isOriginAllowed("http://localhost:3001")).toBe(true);
    expect(isOriginAllowed("http://localhost:5173")).toBe(true);
  });

  it("rejects an unknown origin", () => {
    expect(isOriginAllowed("https://evil.example.com")).toBe(false);
    expect(isOriginAllowed("http://localhost:9999")).toBe(false);
  });

  it("rejects an empty string (no Origin header)", () => {
    expect(isOriginAllowed("")).toBe(false);
  });

  it("allows the FRONTEND_URL origin when configured", () => {
    vi.stubEnv("FRONTEND_URL", "https://momentum.vercel.app");
    expect(isOriginAllowed("https://momentum.vercel.app")).toBe(true);
  });

  it("does not allow FRONTEND_URL with a different scheme", () => {
    vi.stubEnv("FRONTEND_URL", "https://momentum.vercel.app");
    // HTTP variant of the same host is a different origin
    expect(isOriginAllowed("http://momentum.vercel.app")).toBe(false);
  });

  it("does not allow FRONTEND_URL with a trailing slash", () => {
    vi.stubEnv("FRONTEND_URL", "https://momentum.vercel.app");
    // Browsers strip trailing slashes from the Origin header, but
    // this test documents that the matching is exact.
    expect(isOriginAllowed("https://momentum.vercel.app/")).toBe(false);
  });

  it("allows origins added via ADDITIONAL_ORIGINS", () => {
    vi.stubEnv("ADDITIONAL_ORIGINS", "https://preview-pr-42.vercel.app");
    expect(isOriginAllowed("https://preview-pr-42.vercel.app")).toBe(true);
  });

  it("rejects an origin not in ADDITIONAL_ORIGINS", () => {
    vi.stubEnv("ADDITIONAL_ORIGINS", "https://preview-pr-42.vercel.app");
    expect(isOriginAllowed("https://attacker.example.com")).toBe(false);
  });
});

// ─── buildCorsHeaders ─────────────────────────────────────────────────────────

describe("buildCorsHeaders", () => {
  const ORIGIN = "https://momentum.vercel.app";

  it("sets Access-Control-Allow-Origin to the specific origin (never *)", () => {
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
  });

  it("sets Vary: Origin to prevent incorrect caching by shared caches", () => {
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Vary"]).toBe("Origin");
  });

  it("does NOT set Access-Control-Allow-Credentials (bearer token model)", () => {
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

// ─── buildPreflightHeaders ────────────────────────────────────────────────────

describe("buildPreflightHeaders", () => {
  const ORIGIN = "https://momentum.vercel.app";

  it("sets Access-Control-Allow-Origin to the specific origin", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
  });

  it("includes Authorization in Access-Control-Allow-Headers", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    const allowed = headers["Access-Control-Allow-Headers"] ?? "";
    expect(allowed).toContain("Authorization");
  });

  it("includes Content-Type in Access-Control-Allow-Headers", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });

  it("includes X-Request-ID in Access-Control-Allow-Headers", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-Request-ID");
  });

  it("includes all required methods in Access-Control-Allow-Methods", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    const methods = headers["Access-Control-Allow-Methods"] ?? "";
    for (const m of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]) {
      expect(methods).toContain(m);
    }
  });

  it("sets Access-Control-Max-Age to a positive integer string", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    const age = Number(headers["Access-Control-Max-Age"]);
    expect(age).toBeGreaterThan(0);
  });

  it("sets Vary: Origin", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Vary"]).toBe("Origin");
  });

  it("does NOT set Access-Control-Allow-Credentials", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("exposes the same constants as the module-level exports", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Headers"]).toBe(CORS_ALLOW_HEADERS);
    expect(headers["Access-Control-Allow-Methods"]).toBe(CORS_ALLOW_METHODS);
  });
});
