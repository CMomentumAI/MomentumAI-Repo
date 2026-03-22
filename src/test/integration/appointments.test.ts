/**
 * Integration tests for appointment routes.
 *
 * Coverage:
 *  POST /api/appointments           — create
 *  GET  /api/appointments           — paginated list, no rawTranscript in response
 *  GET  /api/appointments/:id       — detail, no rawTranscript
 *  PATCH /api/appointments/:id      — update fields
 *  DELETE /api/appointments/:id     — soft delete
 *  POST /api/appointments/:id/transcript — upload
 *  GET  /api/appointments/:id/transcript — presigned download URL
 *  GET  /api/appointments/:id/summary   — presigned download URL (error when missing)
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
import { GET as listAppointments, POST as createAppointment } from "@/app/api/appointments/route";
import {
  GET as getAppointment,
  PATCH as patchAppointment,
  DELETE as deleteAppointment,
} from "@/app/api/appointments/[id]/route";
import {
  GET as getTranscriptUrl,
  POST as uploadTranscript,
} from "@/app/api/appointments/[id]/transcript/route";
import { GET as getSummaryUrl } from "@/app/api/appointments/[id]/summary/route";
import { _resetDenylistForTesting } from "@/lib/token-denylist";
import { _resetRateLimitersForTesting } from "@/lib/rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new Request("http://localhost/api/test", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeRouteCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

let authToken = "";

async function setupUser() {
  const res = await register(
    makeRequest("POST", { email: "appt@test.example", password: "Password1", name: "Appt User" }) as any,
  );
  const body = await res.json();
  authToken = body.data.token;
}

async function createOne(token: string, overrides: Record<string, unknown> = {}) {
  const res = await createAppointment(
    makeRequest("POST", { title: "Test Appointment", date: new Date().toISOString(), ...overrides }, token) as any,
  );
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.data as { id: string; status: string };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/appointments", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("creates an appointment and returns a safe view (no rawTranscript)", async () => {
    const res = await createAppointment(
      makeRequest(
        "POST",
        { title: "Cardiology Visit", date: "2025-01-15T10:00:00.000Z" },
        authToken,
      ) as any,
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.title).toBe("Cardiology Visit");
    expect(body.data.rawTranscript).toBeUndefined();
    expect(typeof body.data.hasTranscript).toBe("boolean");
  });

  it("returns 401 without auth", async () => {
    const res = await createAppointment(
      makeRequest("POST", { title: "X" }) as any,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for an empty title", async () => {
    const res = await createAppointment(
      makeRequest("POST", { title: "" }, authToken) as any,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/appointments", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("returns a paginated response with no rawTranscript", async () => {
    await createOne(authToken);
    await createOne(authToken, { title: "Second" });

    const res = await listAppointments(makeRequest("GET", undefined, authToken) as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.pagination.total).toBe(2);
    expect(body.data.pagination.page).toBe(1);
    // rawTranscript must never appear in list response
    for (const item of body.data.items) {
      expect(item.rawTranscript).toBeUndefined();
      expect(typeof item.hasTranscript).toBe("boolean");
    }
  });

  it("respects ?page and ?limit params", async () => {
    for (let i = 0; i < 5; i++) {
      await createOne(authToken, { title: `Appointment ${i}` });
    }

    const res = await listAppointments(
      new Request("http://localhost/api/appointments?page=2&limit=2", {
        headers: { Authorization: `Bearer ${authToken}` },
      }) as any,
    );
    const body = await res.json();
    expect(body.data.pagination.page).toBe(2);
    expect(body.data.pagination.limit).toBe(2);
    expect(body.data.items.length).toBeLessThanOrEqual(2);
    expect(body.data.pagination.hasPrev).toBe(true);
  });

  it("returns empty items when no appointments exist", async () => {
    const res = await listAppointments(makeRequest("GET", undefined, authToken) as any);
    const body = await res.json();
    expect(body.data.pagination.total).toBe(0);
    expect(body.data.items).toHaveLength(0);
  });
});

describe("GET /api/appointments/:id", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("returns the appointment without rawTranscript", async () => {
    const created = await createOne(authToken, { title: "Detail Test" });

    const res = await getAppointment(
      makeRequest("GET", undefined, authToken) as any,
      makeRouteCtx(created.id),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe(created.id);
    expect(body.data.rawTranscript).toBeUndefined();
    expect(typeof body.data.hasTranscript).toBe("boolean");
  });

  it("returns 404 for a non-existent appointment", async () => {
    const res = await getAppointment(
      makeRequest("GET", undefined, authToken) as any,
      makeRouteCtx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/appointments/:id", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("updates allowed fields", async () => {
    const created = await createOne(authToken);

    const res = await patchAppointment(
      makeRequest("PATCH", { title: "Updated Title", doctorName: "Dr. Smith" }, authToken) as any,
      makeRouteCtx(created.id),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.title).toBe("Updated Title");
    expect(body.data.doctorName).toBe("Dr. Smith");
    expect(body.data.rawTranscript).toBeUndefined();
  });
});

describe("DELETE /api/appointments/:id", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("soft-deletes the appointment so it no longer appears in the list", async () => {
    const created = await createOne(authToken);

    const deleteRes = await deleteAppointment(
      makeRequest("DELETE", undefined, authToken) as any,
      makeRouteCtx(created.id),
    );
    expect(deleteRes.status).toBe(200);

    // GET should now 404
    const getRes = await getAppointment(
      makeRequest("GET", undefined, authToken) as any,
      makeRouteCtx(created.id),
    );
    expect(getRes.status).toBe(404);

    // List should not include the deleted item
    const listRes = await listAppointments(makeRequest("GET", undefined, authToken) as any);
    const listBody = await listRes.json();
    expect(listBody.data.pagination.total).toBe(0);
  });
});

describe("Transcript download (GET /api/appointments/:id/transcript)", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("returns a presigned URL after the transcript has been uploaded", async () => {
    const created = await createOne(authToken);

    // Upload transcript
    await uploadTranscript(
      makeRequest("POST", { transcript: "Doctor: Hello. Patient: Hi there." }, authToken) as any,
      makeRouteCtx(created.id),
    );

    // Get download URL
    const res = await getTranscriptUrl(
      makeRequest("GET", undefined, authToken) as any,
      makeRouteCtx(created.id),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.url).toMatch(/^https:\/\//);
    expect(body.data.expiresInSeconds).toBe(300);
  });

  it("returns 404 when no transcript exists", async () => {
    const created = await createOne(authToken);
    const res = await getTranscriptUrl(
      makeRequest("GET", undefined, authToken) as any,
      makeRouteCtx(created.id),
    );
    expect(res.status).toBe(404);
  });
});

describe("Summary download (GET /api/appointments/:id/summary)", () => {
  beforeEach(async () => {
    s3Store.clear();
    _resetDenylistForTesting();
    _resetRateLimitersForTesting();
    await setupUser();
  });

  it("returns 404 when no summary exists yet", async () => {
    const created = await createOne(authToken);
    const res = await getSummaryUrl(
      makeRequest("GET", undefined, authToken) as any,
      makeRouteCtx(created.id),
    );
    expect(res.status).toBe(404);
  });
});
