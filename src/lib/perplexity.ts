/**
 * Perplexity API client.
 * Perplexity exposes an OpenAI-compatible REST API.
 *
 * All calls include a hard timeout and automatic exponential-backoff retry
 * for transient failures (rate limits, 5xx). Raw API response bodies are
 * intentionally excluded from thrown errors to avoid leaking prompt content
 * or provider-side debug data into application logs.
 */

import { getEnv } from "./env";
import {
  ExternalApiError,
  classifyHttpStatus,
  withRetry,
  isTransientError,
  makeTimeoutSignal,
} from "./resilience";

// ─── Constants ────────────────────────────────────────────────────────────────

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "llama-3.1-sonar-large-128k-online";
const PROVIDER = "perplexity";

/** Hard timeout per request attempt. Summarization can take up to 30 s. */
const REQUEST_TIMEOUT_MS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PerplexityMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PerplexityResponse {
  id: string;
  model: string;
  choices: { message: { content: string } }[];
  citations?: string[];
}

// ─── Core client ─────────────────────────────────────────────────────────────

/**
 * Send a chat completion request to Perplexity.
 *
 * Retries up to 3 times on rate-limit (429) or server errors (5xx).
 * Throws ExternalApiError with a typed code on failure.
 */
export async function perplexityChat(
  messages: PerplexityMessage[],
  model = DEFAULT_MODEL,
): Promise<PerplexityResponse> {
  const apiKey = getEnv().PERPLEXITY_API_KEY;

  return withRetry(
    async () => {
      const response = await fetch(PERPLEXITY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages }),
        signal: makeTimeoutSignal(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const { code, isRetryable } = classifyHttpStatus(response.status);
        throw new ExternalApiError(
          `Perplexity API returned HTTP ${response.status}`,
          code,
          PROVIDER,
          response.status,
          isRetryable,
        );
      }

      return response.json() as Promise<PerplexityResponse>;
    },
    isTransientError,
  );
}

// ─── Appointment summarization ────────────────────────────────────────────────

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  prescriptions: {
    medication: string;
    dosage: string;
    frequency: string;
    notes?: string;
  }[];
  followUps: string[];
  /** Actual model identifier returned by the Perplexity API. */
  model: string;
}

/**
 * Summarize an appointment transcript using Perplexity.
 *
 * Returns a structured summary including key points, prescriptions, and
 * follow-up actions. The `model` field records which Perplexity model
 * produced the result for audit and processing metadata.
 *
 * Falls back gracefully if the model returns malformed JSON — the raw
 * content is captured as the summary so no data is silently discarded.
 */
export async function summarizeAppointmentTranscript(
  transcript: string,
  patientName?: string,
): Promise<SummaryResult> {
  const systemPrompt = `You are a medical assistant helping ${patientName ?? "a patient"} understand their doctor's appointment.
Analyze the following appointment transcript and extract structured information.
Always respond with valid JSON matching this exact schema:
{
  "summary": "2-3 sentence plain-language summary",
  "keyPoints": ["point 1", "point 2"],
  "prescriptions": [{"medication": "...", "dosage": "...", "frequency": "...", "notes": "..."}],
  "followUps": ["follow-up action 1", "follow-up action 2"]
}`;

  const result = await perplexityChat([
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Please analyze this appointment transcript:\n\n${transcript}`,
    },
  ]);

  const modelId = result.model ?? DEFAULT_MODEL;
  const content = result.choices[0]?.message?.content ?? "{}";

  // Strip markdown code fences if present.
  const cleaned = content
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Omit<SummaryResult, "model">;
    return {
      summary: parsed.summary ?? "",
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      prescriptions: Array.isArray(parsed.prescriptions)
        ? parsed.prescriptions
        : [],
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
      model: `perplexity/${modelId}`,
    };
  } catch {
    // Fallback: model returned something that couldn't be parsed as JSON.
    // Preserve the raw content as the summary rather than discarding it.
    return {
      summary: content,
      keyPoints: [],
      prescriptions: [],
      followUps: [],
      model: `perplexity/${modelId}`,
    };
  }
}
