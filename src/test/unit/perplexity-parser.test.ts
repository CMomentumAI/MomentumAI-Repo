/**
 * Tests for summarizeAppointmentTranscript's parsing/normalization logic.
 *
 * All tests mock the global `fetch` to avoid real Perplexity API calls.
 * The retry logic is exercised inline (withRetry calls the fn once on success).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { summarizeAppointmentTranscript } from "@/lib/perplexity";

// Helper to build a fake Perplexity API response
function fakePerplexityResponse(content: string, model = "llama-3.1-sonar-large") {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        id: "test-id",
        model,
        choices: [{ message: { content } }],
        citations: [],
      }),
  };
}

describe("summarizeAppointmentTranscript", () => {
  beforeEach(() => {
    // Stub global fetch — no real HTTP requests made
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a well-formed JSON response into a SummaryResult", async () => {
    const payload = JSON.stringify({
      summary: "Patient had routine checkup.",
      keyPoints: ["BP normal", "Cholesterol OK"],
      prescriptions: [
        { medication: "Vitamin D", dosage: "2000 IU", frequency: "daily" },
      ],
      followUps: ["Return in 3 months"],
    });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakePerplexityResponse(payload),
    );

    const result = await summarizeAppointmentTranscript("Doctor: Hello. Patient: Hi.");

    expect(result.summary).toBe("Patient had routine checkup.");
    expect(result.keyPoints).toEqual(["BP normal", "Cholesterol OK"]);
    expect(result.prescriptions).toHaveLength(1);
    expect(result.prescriptions[0].medication).toBe("Vitamin D");
    expect(result.followUps).toEqual(["Return in 3 months"]);
    expect(result.model).toBe("perplexity/llama-3.1-sonar-large");
  });

  it("strips markdown code fences before parsing", async () => {
    const payload =
      "```json\n" +
      JSON.stringify({ summary: "All good.", keyPoints: [], prescriptions: [], followUps: [] }) +
      "\n```";

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakePerplexityResponse(payload),
    );

    const result = await summarizeAppointmentTranscript("test transcript");
    expect(result.summary).toBe("All good.");
  });

  it("falls back gracefully when the model returns non-JSON", async () => {
    const prose = "The patient is doing well and should rest.";

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakePerplexityResponse(prose),
    );

    const result = await summarizeAppointmentTranscript("test transcript");

    // Raw content becomes the summary
    expect(result.summary).toBe(prose);
    expect(result.keyPoints).toEqual([]);
    expect(result.prescriptions).toEqual([]);
    expect(result.followUps).toEqual([]);
  });

  it("normalizes non-array fields to empty arrays", async () => {
    const payload = JSON.stringify({
      summary: "OK",
      keyPoints: null,     // invalid — should default to []
      prescriptions: "none", // invalid — should default to []
      followUps: undefined, // invalid — should default to []
    });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakePerplexityResponse(payload),
    );

    const result = await summarizeAppointmentTranscript("test transcript");
    expect(result.keyPoints).toEqual([]);
    expect(result.prescriptions).toEqual([]);
    expect(result.followUps).toEqual([]);
  });

  it("uses the model identifier returned by the API in the result", async () => {
    const payload = JSON.stringify({
      summary: "Fine.",
      keyPoints: [],
      prescriptions: [],
      followUps: [],
    });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakePerplexityResponse(payload, "my-custom-model"),
    );

    const result = await summarizeAppointmentTranscript("test transcript");
    expect(result.model).toBe("perplexity/my-custom-model");
  });

  it("propagates an ExternalApiError when Perplexity returns a non-2xx status", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    await expect(
      summarizeAppointmentTranscript("test transcript"),
    ).rejects.toMatchObject({
      name: "ExternalApiError",
      code: "AUTH_ERROR",
    });
  });
});
