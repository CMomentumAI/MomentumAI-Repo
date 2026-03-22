/**
 * Unit tests for the CORS helper (src/lib/cors.ts).
 *
 * The cors module reads process.env directly (no getEnv() singleton) so tests
 * can control env vars using vi.stubEnv without needing resetEnvCache().
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEV_ORIGINS,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  getAllowedOrigins,
  isOriginAllowed,
  isCorsCredentialsEnabled,
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

  it("includes a single origin from CORS_ALLOWED_ORIGINS", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://momentum.vercel.app");
    const origins = getAllowedOrigins();
    expect(origins.has("https://momentum.vercel.app")).toBe(true);
  });

  it("includes multiple comma-separated origins from CORS_ALLOWED_ORIGINS", () => {
    vi.stubEnv(
      "CORS_ALLOWED_ORIGINS",
      "https://preview-a.vercel.app, https://preview-b.vercel.app",
    );
    const origins = getAllowedOrigins();
    expect(origins.has("https://preview-a.vercel.app")).toBe(true);
    expect(origins.has("https://preview-b.vercel.app")).toBe(true);
  });

  it("ignores empty entries (trailing comma, double comma)", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://preview.vercel.app,,");
    const origins = getAllowedOrigins();
    expect(origins.has("https://preview.vercel.app")).toBe(true);
    expect(origins.has("")).toBe(false);
  });

  it("returns only dev origins when CORS_ALLOWED_ORIGINS is empty", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "");
    const origins = getAllowedOrigins();
    expect(origins.size).toBe(DEV_ORIGINS.length);
    for (const o of DEV_ORIGINS) {
      expect(origins.has(o)).toBe(true);
    }
  });

  it("trims whitespace around each entry", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "  https://a.example.com  ,  https://b.example.com  ");
    const origins = getAllowedOrigins();
    expect(origins.has("https://a.example.com")).toBe(true);
    expect(origins.has("https://b.example.com")).toBe(true);
    expect(origins.has("  https://a.example.com  ")).toBe(false);
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

  it("allows an origin listed in CORS_ALLOWED_ORIGINS", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://momentum.vercel.app");
    expect(isOriginAllowed("https://momentum.vercel.app")).toBe(true);
  });

  it("does not allow the same host with a different scheme", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://momentum.vercel.app");
    expect(isOriginAllowed("http://momentum.vercel.app")).toBe(false);
  });

  it("does not allow a URL with a trailing slash", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://momentum.vercel.app");
    // Browsers strip trailing slashes from the Origin header; this test
    // documents that matching is exact so misconfiguration fails clearly.
    expect(isOriginAllowed("https://momentum.vercel.app/")).toBe(false);
  });

  it("allows a preview origin listed in CORS_ALLOWED_ORIGINS", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://preview-pr-42.vercel.app");
    expect(isOriginAllowed("https://preview-pr-42.vercel.app")).toBe(true);
  });

  it("rejects an origin not in CORS_ALLOWED_ORIGINS", () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "https://preview-pr-42.vercel.app");
    expect(isOriginAllowed("https://attacker.example.com")).toBe(false);
  });
});

// ─── isCorsCredentialsEnabled ─────────────────────────────────────────────────

describe("isCorsCredentialsEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when CORS_ALLOW_CREDENTIALS is not set", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "");
    expect(isCorsCredentialsEnabled()).toBe(false);
  });

  it("returns true when CORS_ALLOW_CREDENTIALS is 'true'", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "true");
    expect(isCorsCredentialsEnabled()).toBe(true);
  });

  it("returns true for 'TRUE' (case-insensitive)", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "TRUE");
    expect(isCorsCredentialsEnabled()).toBe(true);
  });

  it("returns false for 'false'", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "false");
    expect(isCorsCredentialsEnabled()).toBe(false);
  });

  it("returns false for any non-'true' value", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "yes");
    expect(isCorsCredentialsEnabled()).toBe(false);
  });
});

// ─── buildCorsHeaders ─────────────────────────────────────────────────────────

describe("buildCorsHeaders", () => {
  const ORIGIN = "https://momentum.vercel.app";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets Access-Control-Allow-Origin to the specific origin (never *)", () => {
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
  });

  it("sets Vary: Origin to prevent incorrect caching by shared caches", () => {
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Vary"]).toBe("Origin");
  });

  it("does NOT set Access-Control-Allow-Credentials when disabled (default)", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "false");
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("sets Access-Control-Allow-Credentials: true when CORS_ALLOW_CREDENTIALS=true", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "true");
    const headers = buildCorsHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });
});

// ─── buildPreflightHeaders ────────────────────────────────────────────────────

describe("buildPreflightHeaders", () => {
  const ORIGIN = "https://momentum.vercel.app";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets Access-Control-Allow-Origin to the specific origin", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
  });

  it("includes Authorization in Access-Control-Allow-Headers", () => {
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Headers"]).toContain("Authorization");
  });

  it("includes Content-Type in Access-Control-Allow-Headers", () => {
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });

  it("includes Accept in Access-Control-Allow-Headers", () => {
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Headers"]).toContain("Accept");
  });

  it("includes X-Requested-With in Access-Control-Allow-Headers", () => {
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Headers"]).toContain("X-Requested-With");
  });

  it("includes X-Request-ID in Access-Control-Allow-Headers", () => {
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Headers"]).toContain("X-Request-ID");
  });

  it("includes all required methods in Access-Control-Allow-Methods", () => {
    const methods = buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Methods"] ?? "";
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(methods).toContain(m);
    }
  });

  it("sets Access-Control-Max-Age to a positive integer string", () => {
    const age = Number(buildPreflightHeaders(ORIGIN)["Access-Control-Max-Age"]);
    expect(age).toBeGreaterThan(0);
  });

  it("sets Vary: Origin", () => {
    expect(buildPreflightHeaders(ORIGIN)["Vary"]).toBe("Origin");
  });

  it("does NOT set Access-Control-Allow-Credentials when disabled (default)", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "false");
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("sets Access-Control-Allow-Credentials: true when CORS_ALLOW_CREDENTIALS=true", () => {
    vi.stubEnv("CORS_ALLOW_CREDENTIALS", "true");
    expect(buildPreflightHeaders(ORIGIN)["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("exposes the same constants as the module-level exports", () => {
    const headers = buildPreflightHeaders(ORIGIN);
    expect(headers["Access-Control-Allow-Headers"]).toBe(CORS_ALLOW_HEADERS);
    expect(headers["Access-Control-Allow-Methods"]).toBe(CORS_ALLOW_METHODS);
  });
});
