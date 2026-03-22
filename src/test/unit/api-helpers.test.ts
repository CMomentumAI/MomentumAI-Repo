/**
 * Tests for shared API helper functions.
 *
 * These functions are pure (no S3, no DB, no external calls) so no mocking
 * is needed beyond JWT token creation.
 */

import { describe, it, expect } from "vitest";
import { signToken } from "@/lib/auth";
import {
  requireAuth,
  requireOwnership,
  successResponse,
  errorResponse,
  rateLimitResponse,
  toSafeAppointment,
} from "@/lib/api-helpers";
import type { JWTPayload } from "@/lib/auth";
import type { Appointment } from "@/types";

const SAMPLE_USER: Omit<JWTPayload, "iat" | "exp"> = {
  sub: "patient-abc",
  email: "patient@example.com",
  name: "Test Patient",
};

// ─── requireAuth ──────────────────────────────────────────────────────────────

describe("requireAuth", () => {
  it("returns the decoded user payload for a valid Bearer token", () => {
    const token = signToken(SAMPLE_USER);
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = requireAuth(request);

    expect("user" in result).toBe(true);
    if ("user" in result) {
      expect(result.user.sub).toBe(SAMPLE_USER.sub);
    }
  });

  it("returns a 401 NextResponse when Authorization header is absent", async () => {
    const request = new Request("http://localhost/api/test");
    const result = requireAuth(request);

    expect("status" in result).toBe(true);
    if ("status" in result) {
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/unauthorized/i);
    }
  });

  it("returns a 401 NextResponse for a malformed token", async () => {
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer not.a.real.jwt" },
    });
    const result = requireAuth(request);

    expect("status" in result).toBe(true);
    if ("status" in result) {
      expect(result.status).toBe(401);
    }
  });

  it("returns a 401 NextResponse when only 'Bearer ' prefix is present (empty token)", async () => {
    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer " },
    });
    const result = requireAuth(request);

    expect("status" in result).toBe(true);
    if ("status" in result) {
      expect(result.status).toBe(401);
    }
  });
});

// ─── requireOwnership ─────────────────────────────────────────────────────────

describe("requireOwnership", () => {
  const user = { ...SAMPLE_USER, iat: 0, exp: 9999999999 };

  it("returns null when the user owns the resource", () => {
    const result = requireOwnership(user, user.sub);
    expect(result).toBeNull();
  });

  it("returns a 403 NextResponse when the user does not own the resource", async () => {
    const result = requireOwnership(user, "someone-elses-id");

    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/forbidden/i);
  });
});

// ─── successResponse ─────────────────────────────────────────────────────────

describe("successResponse", () => {
  it("returns a 200 with { success: true, data } by default", async () => {
    const response = successResponse({ id: "x" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: "x" });
  });

  it("includes the message field when provided", async () => {
    const response = successResponse({ id: "x" }, "Created", 201);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.message).toBe("Created");
  });
});

// ─── errorResponse ────────────────────────────────────────────────────────────

describe("errorResponse", () => {
  it("returns a 400 with { success: false, error } by default", async () => {
    const response = errorResponse("Validation failed");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation failed");
  });

  it("includes details when provided", async () => {
    const details = { field: "email", message: "invalid" };
    const response = errorResponse("Validation failed", 422, details);
    const body = await response.json();
    expect(body.details).toEqual(details);
  });

  it("uses the supplied status code", async () => {
    const response = errorResponse("Not found", 404);
    expect(response.status).toBe(404);
  });
});

// ─── toSafeAppointment ────────────────────────────────────────────────────────

const BASE_APPOINTMENT: Appointment = {
  id: "appt-1",
  patientId: "patient-1",
  title: "General Checkup",
  date: "2025-01-15T10:00:00.000Z",
  status: "summarized",
  keyPoints: [],
  prescriptions: [],
  followUps: [],
  createdAt: "2025-01-15T10:00:00.000Z",
  updatedAt: "2025-01-15T10:00:00.000Z",
};

describe("toSafeAppointment", () => {
  it("strips rawTranscript from the returned view", () => {
    const appt: Appointment = {
      ...BASE_APPOINTMENT,
      rawTranscript: "Doctor: Hello. Patient: Hi.",
    };
    const safe = toSafeAppointment(appt);
    expect((safe as Record<string, unknown>).rawTranscript).toBeUndefined();
  });

  it("sets hasTranscript=true when rawTranscript is present", () => {
    const appt: Appointment = {
      ...BASE_APPOINTMENT,
      rawTranscript: "Doctor: Hello.",
    };
    expect(toSafeAppointment(appt).hasTranscript).toBe(true);
  });

  it("sets hasTranscript=true when transcriptS3Key is present (no inline text)", () => {
    const appt: Appointment = {
      ...BASE_APPOINTMENT,
      transcriptS3Key: "development/patients/p1/transcripts/appt1_transcript.txt",
    };
    expect(toSafeAppointment(appt).hasTranscript).toBe(true);
  });

  it("sets hasTranscript=false when neither rawTranscript nor transcriptS3Key are present", () => {
    expect(toSafeAppointment(BASE_APPOINTMENT).hasTranscript).toBe(false);
  });

  it("preserves all other fields unchanged", () => {
    const safe = toSafeAppointment(BASE_APPOINTMENT);
    expect(safe.id).toBe(BASE_APPOINTMENT.id);
    expect(safe.title).toBe(BASE_APPOINTMENT.title);
    expect(safe.status).toBe(BASE_APPOINTMENT.status);
  });
});

// ─── rateLimitResponse ────────────────────────────────────────────────────────

describe("rateLimitResponse", () => {
  it("returns a 429 status", async () => {
    const resetAt = Date.now() + 30_000;
    const response = rateLimitResponse(resetAt);
    expect(response.status).toBe(429);
  });

  it("sets a Retry-After header of at least 1 second", () => {
    const resetAt = Date.now() + 10_000;
    const response = rateLimitResponse(resetAt);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("rounds Retry-After up to 1 when resetAt is in the past", () => {
    const resetAt = Date.now() - 1000; // already passed
    const response = rateLimitResponse(resetAt);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBe(1);
  });
});
