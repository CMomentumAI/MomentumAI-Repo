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
import { requireAuth, errorResponse } from "@/lib/api-helpers";

const MAX_TTS_CHARS = 5000;

const TTSSchema = z.object({
  text: z
    .string()
    .min(1, "Text cannot be empty")
    .max(MAX_TTS_CHARS, `Text must be under ${MAX_TTS_CHARS} characters`),
  voiceId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;

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

    return new NextResponse(audioBuffer.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.length.toString(),
        // Prevent caching of audio streams
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "TTS failed";
    console.error("[voice:POST]", error);

    if (message.includes("ELEVENLABS_API_KEY")) {
      return errorResponse("Voice service is not configured", 503);
    }

    return errorResponse("Failed to generate audio", 500);
  }
}
