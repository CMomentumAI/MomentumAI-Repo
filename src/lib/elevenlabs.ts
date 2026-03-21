/**
 * ElevenLabs Text-to-Speech client.
 */

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel — calm, medical-friendly

export interface TTSOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
}

/**
 * Convert text to speech audio using ElevenLabs.
 * Returns raw MP3 audio bytes.
 */
export async function textToSpeech(
  text: string,
  options: TTSOptions = {},
): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

  const voiceId = options.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
  const modelId = options.modelId ?? "eleven_turbo_v2";

  const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
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
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Fetch available voices from ElevenLabs.
 */
export async function listVoices(): Promise<
  { voice_id: string; name: string; category: string }[]
> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

  const response = await fetch(`${ELEVENLABS_API_URL}/voices`, {
    headers: { "xi-api-key": apiKey },
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs voices error ${response.status}`);
  }

  const data = (await response.json()) as { voices: { voice_id: string; name: string; category: string }[] };
  return data.voices;
}
