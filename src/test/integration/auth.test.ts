/**
 * Integration tests for the auth routes.
 *
 * These tests call the actual route handler functions with real Request objects.
 * AWS S3 is replaced by an in-memory store so tests run offline.
 *
 * Coverage:
 *  POST /api/auth/register  — success, duplicate, validation
 *  POST /api/auth/login     — success, wrong password, unknown email
 *  POST /api/auth/logout    — success, revoked token rejected
 *  GET  /api/auth/me        — authenticated, missing token
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── In-memory S3 mock ────────────────────────────────────────────────────────

const { s3Store } = vi.hoisted(() => ({ s3Store: new Map<string, string>() }));

vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...actual,
    uploadToS3: vi.fn(async (key: string, body: string | Buffer) => {
      s3Store.set(key, Buffer.isBuffer(body) ? body.toString("utf-8") : String(body));
      return key;
    }),
    downloadFromS3: vi.fn(async (key: string) => {
      const val = s3Store.get(key);
      if (!val) throw new actual.S3StorageError(`Not found: ${key}`, "NOT_FOUND", key);
      return val;
    }),
    deleteFromS3: vi.fn(async (key: string) => { s3Store.delete(key); }),
    getPresignedDownloadUrl: vi.fn(async (key: string) =>
      `https://fake-s3.test/${encodeURIComponent(key)}`
    ),
    getObjectMetadata: vi.fn(async (key: string) =>
      s3Store.has(key) ? { contentType: "application/json" } : null
    ),
  };
});

// ─── Route handlers ───────────────────────────────────────────────────────────

import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { _resetDenylistForTesting } from "@/lib/token-denylist";
import { _resetRateLimitersForTesting } from "@/lib/rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new Request("http://localhost/api/auth/test", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function registerDemo(
  email = "demo@test.example",
  password = "Password1!",
  name = "Demo User",
): Promise<{ token: string }> {
  const res = await register(makeRequest("POST", { email, password, name }) as any);
  const body = await res.json();
  expect(body.success).toBe(true);
  return { token: body.data.token };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
  });

  it("creates a new account and returns a JWT token", async () => {
    const res = await register(
      makeRequest("POST", {
        email: "alice@test.example",
        password: "Password1",
        name: "Alice",
      }) as any,
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.token).toBeTruthy();
    expect(body.data.patient.email).toBe("alice@test.example");
    expect(body.data.patient.passwordHash).toBeUndefined();
  });

  it("returns 409 on duplicate email", async () => {
    const payload = { email: "bob@test.example", password: "Password1", name: "Bob" };
    await register(makeRequest("POST", payload) as any);
    const res2 = await register(makeRequest("POST", payload) as any);

    expect(res2.status).toBe(409);
    const body = await res2.json();
    expect(body.success).toBe(false);
  });

  it("returns 400 for an invalid email", async () => {
    const res = await register(
      makeRequest("POST", { email: "not-an-email", password: "Password1", name: "X" }) as any,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is too weak", async () => {
    const res = await register(
      makeRequest("POST", { email: "c@test.example", password: "short", name: "C" }) as any,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await registerDemo("user@test.example", "SecurePass1", "Test User");
  });

  it("returns a token for valid credentials", async () => {
    const res = await login(
      makeRequest("POST", { email: "user@test.example", password: "SecurePass1" }) as any,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.token).toBeTruthy();
  });

  it("returns 401 for wrong password", async () => {
    const res = await login(
      makeRequest("POST", { email: "user@test.example", password: "WrongPass99" }) as any,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 for unknown email", async () => {
    const res = await login(
      makeRequest("POST", { email: "nobody@test.example", password: "Password1" }) as any,
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
  });

  it("revokes the token so subsequent requests return 401", async () => {
    const { token } = await registerDemo();

    // Confirm the token is valid first
    const meRes1 = await me(makeRequest("GET", undefined, token) as any);
    expect(meRes1.status).toBe(200);

    // Log out
    const logoutRes = await logout(makeRequest("POST", undefined, token) as any);
    expect(logoutRes.status).toBe(200);

    // The same token should now be rejected
    const meRes2 = await me(makeRequest("GET", undefined, token) as any);
    expect(meRes2.status).toBe(401);
    const body = await meRes2.json();
    expect(body.error).toMatch(/revoked/i);
  });

  it("returns 401 without a token", async () => {
    const res = await logout(makeRequest("POST") as any);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
  });

  it("returns the patient profile for an authenticated user", async () => {
    const { token } = await registerDemo("me@test.example", "Password1", "Me User");
    const res = await me(makeRequest("GET", undefined, token) as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.email).toBe("me@test.example");
    expect(body.data.passwordHash).toBeUndefined();
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await me(makeRequest("GET") as any);
    expect(res.status).toBe(401);
  });
});
