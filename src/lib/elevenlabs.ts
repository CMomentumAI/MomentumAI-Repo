/**
 * ElevenLabs Text-to-Speech client.
 *
 * Only the explicitly provided `text` argument is synthesized — no chat
 * history or other context is forwarded to ElevenLabs, preventing unintended
 * synthesis of conversation history or PHI from previous messages.
 *
 * All calls include a hard timeout and automatic retry for transient failures.
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

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel — calm, medical-friendly
const PROVIDER = "elevenlabs";

/** Hard timeout per TTS request attempt. */
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TTSOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
}

// ─── Text-to-speech ───────────────────────────────────────────────────────────

/**
 * Convert the provided `text` to MP3 audio bytes using ElevenLabs.
 *
 * Only `text` is sent to ElevenLabs — this function has no access to chat
 * history, RAG context, or any other data, so there is no risk of
 * synthesizing content the caller did not explicitly request.
 *
 * Retries up to 3 times on rate-limit (429) or server errors (5xx).
 * Throws ExternalApiError with a typed code on non-retryable failures.
 */
export async function textToSpeech(
  text: string,
  options: TTSOptions = {},
): Promise<Buffer> {
  const { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } = getEnv();
  const voiceId = options.voiceId ?? ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const modelId = options.modelId ?? "eleven_turbo_v2";
  const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`;

  return withRetry(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: options.stability ?? 0.5,
            similarity_boost: options.similarityBoost ?? 0.75,
            style: options.style ?? 0.0,
            use_speaker_boost: options.speakerBoost ?? true,
          },
        }),
        signal: makeTimeoutSignal(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const { code, isRetryable } = classifyHttpStatus(response.status);
        throw new ExternalApiError(
          `ElevenLabs API returned HTTP ${response.status}`,
          code,
          PROVIDER,
          response.status,
          isRetryable,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
    isTransientError,
  );
}

