/**
 * Perplexity API client.
 * Perplexity exposes an OpenAI-compatible REST API.
 */

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

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const DEFAULT_MODEL = "llama-3.1-sonar-large-128k-online";

/**
 * Send a chat completion request to Perplexity.
 */
export async function perplexityChat(
  messages: PerplexityMessage[],
  model = DEFAULT_MODEL,
): Promise<PerplexityResponse> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not configured");

  const response = await fetch(PERPLEXITY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<PerplexityResponse>;
}

// ─── Appointment summarization ────────────────────────────────────────────────

export async function summarizeAppointmentTranscript(
  transcript: string,
  patientName?: string,
): Promise<{
  summary: string;
  keyPoints: string[];
  prescriptions: { medication: string; dosage: string; frequency: string; notes?: string }[];
  followUps: string[];
}> {
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

  const content = result.choices[0]?.message?.content ?? "{}";

  // Strip markdown code fences if present
  const cleaned = content.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: return raw content as summary
    return {
      summary: content,
      keyPoints: [],
      prescriptions: [],
      followUps: [],
    };
  }
}
