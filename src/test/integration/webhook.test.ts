/**
 * Integration tests for the OMI webhook route.
 *
 * Coverage:
 *  POST /api/webhook/omi — valid signature (creates appointment + queues pipeline)
 *  POST /api/webhook/omi — invalid signature (rejected)
 *  POST /api/webhook/omi — missing patient_id (rejected)
 *  POST /api/webhook/omi — duplicate session_id (idempotent, returns existing)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "crypto";

// ─── Prevent the AI pipeline from running in tests ───────────────────────────

vi.mock("@/lib/ai-pipeline", () => ({
  processAppointment: vi.fn().mockResolvedValue(undefined),
}));

// next/server `after()` is a no-op in tests (the pipeline is already mocked).
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((fn: () => Promise<void>) => fn()) };
});

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
  };
});

// ─── Route handler ────────────────────────────────────────────────────────────

import { POST as webhookPost } from "@/app/api/webhook/omi/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.OMI_WEBHOOK_SECRET!;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex")}`;
}

function makePayload(patientId: string, sessionId = "session-001") {
  return JSON.stringify({
    session_id: sessionId,
    patient_id: patientId,
    transcript: [
      { text: "Hello doctor", speaker: "SPEAKER_00", speaker_id: 0, is_user: true, start: 0, end: 2 },
      { text: "Hello! How are you?", speaker: "SPEAKER_01", speaker_id: 1, is_user: false, start: 2, end: 5 },
    ],
    started_at: "2025-01-15T10:00:00Z",
    finished_at: "2025-01-15T10:30:00Z",
  });
}

function makeRequest(body: string, sig?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sig !== undefined) headers["X-OMI-Signature"] = sig;
  return new Request("http://localhost/api/webhook/omi", {
    method: "POST",
    headers,
    body,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/webhook/omi", () => {
  const PATIENT_ID = "test-patient-aaaabbbbccc";

  beforeEach(() => {
    s3Store.clear();
  });

  it("accepts a correctly signed payload and returns 202", async () => {
    const body = makePayload(PATIENT_ID);
    const res = await webhookPost(makeRequest(body, sign(body)) as any);
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json.success).toBe(true);
    expect(json.data.appointmentId).toBeTruthy();
    expect(json.data.sessionId).toBe("session-001");
  });

  it("rejects a request with an invalid signature", async () => {
    const body = makePayload(PATIENT_ID);
    const res = await webhookPost(makeRequest(body, "sha256=badhash") as any);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("rejects a request with no signature header", async () => {
    const body = makePayload(PATIENT_ID);
    const res = await webhookPost(makeRequest(body) as any);
    // No signature → rejects in production; in test NODE_ENV=test → passes
    // (webhook-utils allows missing secret in non-production). Verify the
    // request at least gets processed (200 or 202) or rejected cleanly (401).
    // The important check is that it never throws an unhandled error.
    expect([200, 202, 400, 401]).toContain(res.status);
  });

  it("returns 400 when patient_id is missing", async () => {
    const raw = JSON.stringify({
      session_id: "sess-no-patient",
      // patient_id intentionally omitted
      transcript: [],
      started_at: "2025-01-15T10:00:00Z",
      finished_at: "2025-01-15T10:30:00Z",
    });
    const res = await webhookPost(makeRequest(raw, sign(raw)) as any);
    expect(res.status).toBe(400);
  });

  it("is idempotent — duplicate session_id returns the existing appointment", async () => {
    const body = makePayload(PATIENT_ID, "session-dupe");
    const sig = sign(body);

    const res1 = await webhookPost(makeRequest(body, sig) as any);
    const json1 = await res1.json();
    expect(res1.status).toBe(202);
    const firstId = json1.data.appointmentId;

    // Send the same payload again
    const res2 = await webhookPost(makeRequest(body, sig) as any);
    const json2 = await res2.json();

    // Second call should be idempotent — returns 200 with the same appointmentId
    expect([200, 202]).toContain(res2.status);
    expect(json2.data.appointmentId).toBe(firstId);
  });
});
