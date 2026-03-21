/**
 * POST /api/voice
 *
 * Convert text to speech using ElevenLabs.
 * Returns MP3 audio bytes with appropriate Content-Type header.
 *
 * Request body:
 *  { text: string, voiceId?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { textToSpeech } from "@/lib/elevenlabs";
import { requireAuth, errorResponse, getRequestId } from "@/lib/api-helpers";
import { logger } from "@/lib/logger";

const MAX_TTS_CHARS = 5000;

const TTSSchema = z.object({
  text: z
    .string()
    .min(1, "Text cannot be empty")
    .max(MAX_TTS_CHARS, `Text must be under ${MAX_TTS_CHARS} characters`),
  voiceId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  try {
    const body = await request.json();
    const parsed = TTSSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const { text, voiceId } = parsed.data;

    const audioBuffer = await textToSpeech(text, { voiceId });

    logger.info("voice:POST", "TTS request handled", {
      requestId,
      userId: user.sub,
      charCount: text.length,
    });

    return new NextResponse(audioBuffer.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.length.toString(),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "TTS failed";
    logger.error("voice:POST", "TTS request failed", error, {
      requestId,
      userId: user.sub,
    });

    if (message.includes("ELEVENLABS_API_KEY")) {
      return errorResponse("Voice service is not configured", 503);
    }

    return errorResponse("Failed to generate audio", 500);
  }
}
