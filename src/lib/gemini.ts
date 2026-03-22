/**
 * Gemini 1.5 Pro RAG pipeline.
 *
 * Architecture:
 *  1. Appointment transcripts/summaries are chunked into small passages.
 *  2. Each chunk is embedded with Gemini text-embedding-004.
 *  3. The embedding index is serialized to JSON and stored in S3 per patient.
 *     (S3 is used because Railway's container filesystem is ephemeral.)
 *  4. At query time the question is embedded and cosine-similarity search
 *     retrieves the top-k relevant chunks.
 *  5. The chunks are injected as context into a Gemini 1.5 Pro chat completion.
 *
 * TIMEOUTS: The Google Generative AI SDK does not expose AbortSignal support
 * for individual calls. Timeouts are therefore enforced via Promise.race(),
 * which rejects the caller but does NOT cancel the underlying HTTP request.
 * Retry logic is applied for transient failures.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildS3Key, downloadFromS3, uploadToS3, S3StorageError } from "./s3";
import { getEnv } from "./env";
import {
  ExternalApiError,
  withRetry,
  isTransientError,
  withTimeoutPromise,
} from "./resilience";
import type { EmbeddingIndex, EmbeddingRecord, ChatMessage } from "@/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER = "gemini";

/** Timeout per single embedding call (SDK does not cancel the HTTP request). */
const EMBED_TIMEOUT_MS = 30_000;

/** Timeout for a full RAG chat completion. */
const CHAT_TIMEOUT_MS = 45_000;

// ─── Client ──────────────────────────────────────────────────────────────────

function getGeminiClient(): GoogleGenerativeAI {
  const { GEMINI_API_KEY } = getEnv();
  return new GoogleGenerativeAI(GEMINI_API_KEY);
}

// ─── Chunking ────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 1500; // characters — tuned for medical transcript coherence
const CHUNK_OVERLAP = 150;

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter((c) => c.length > 0);
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

/**
 * Embed a text passage using Gemini text-embedding-004.
 *
 * Retries up to 3 times on transient failures. Each attempt has a hard
 * timeout enforced via Promise.race (note: the underlying HTTP request is
 * not cancelled on timeout — see module-level comment).
 */
export async function embedText(text: string): Promise<number[]> {
  return withRetry(
    async () => {
      const genAI = getGeminiClient();
      const embeddingModel = genAI.getGenerativeModel({
        model: "text-embedding-004",
      });
      try {
        const result = await withTimeoutPromise(
          embeddingModel.embedContent(text),
          EMBED_TIMEOUT_MS,
          PROVIDER,
        );
        return result.embedding.values;
      } catch (err) {
        // Re-wrap SDK errors as ExternalApiError so isTransientError works.
        if (err instanceof ExternalApiError) throw err;
        throw new ExternalApiError(
          `Gemini embedding failed: ${err instanceof Error ? err.message : String(err)}`,
          "PROVIDER_ERROR",
          PROVIDER,
          undefined,
          // Treat unknown SDK errors as potentially retryable for robustness.
          true,
        );
      }
    },
    isTransientError,
  );
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Index management ─────────────────────────────────────────────────────────

const EMBEDDING_INDEX_FILENAME = "embedding_index.json";

async function loadEmbeddingIndex(patientId: string): Promise<EmbeddingIndex> {
  const key = buildS3Key(patientId, "embeddings", EMBEDDING_INDEX_FILENAME);
  try {
    const raw = await downloadFromS3(key);
    const parsed = JSON.parse(raw) as EmbeddingIndex;
    // Validate structure before use to guard against partial writes.
    if (!Array.isArray(parsed.records)) {
      return { patientId, updatedAt: new Date().toISOString(), records: [] };
    }
    return parsed;
  } catch (err) {
    // A missing index is expected before any appointments are indexed.
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") {
      return { patientId, updatedAt: new Date().toISOString(), records: [] };
    }
    // Any other S3 error (permissions, network) should propagate — treating
    // it as "empty index" would silently degrade RAG quality.
    throw err;
  }
}

async function saveEmbeddingIndex(
  patientId: string,
  index: EmbeddingIndex,
): Promise<void> {
  const key = buildS3Key(patientId, "embeddings", EMBEDDING_INDEX_FILENAME);
  await uploadToS3(key, JSON.stringify(index, null, 2), "application/json", {
    category: "embeddings",
    patientId,
  });
}

// ─── Indexing ─────────────────────────────────────────────────────────────────

/**
 * Index a new appointment (transcript + summary) into the patient's embedding
 * store. Stale records for the same appointmentId are removed first to prevent
 * duplicate chunks from accumulating across re-index runs.
 *
 * Chunks are embedded sequentially to respect Gemini's per-minute rate limit.
 * The index is only written to S3 after all chunks succeed, so a mid-run
 * failure leaves the previous index intact rather than producing a partial one.
 */
export async function indexAppointment(
  patientId: string,
  appointmentId: string,
  text: string,
): Promise<void> {
  const chunks = chunkText(text);
  const index = await loadEmbeddingIndex(patientId);

  // Remove stale records before re-indexing.
  index.records = index.records.filter(
    (r) => r.appointmentId !== appointmentId,
  );

  // Embed sequentially — if any chunk fails, throw before writing so the
  // existing index stays consistent.
  const newRecords: EmbeddingRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedText(chunks[i]);
    newRecords.push({ appointmentId, chunkIndex: i, text: chunks[i], embedding });
  }

  index.records.push(...newRecords);
  index.updatedAt = new Date().toISOString();
  await saveEmbeddingIndex(patientId, index);
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/**
 * Find the top-k most relevant chunks for a query using cosine similarity.
 */
export async function retrieveRelevantChunks(
  patientId: string,
  query: string,
  topK = 5,
): Promise<EmbeddingRecord[]> {
  const [queryEmbedding, index] = await Promise.all([
    embedText(query),
    loadEmbeddingIndex(patientId),
  ]);

  if (index.records.length === 0) return [];

  const scored = index.records.map((record) => ({
    record,
    score: cosineSimilarity(queryEmbedding, record.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.record);
}

// ─── Chat with RAG ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Momentum, a patient's personal health AI assistant.
You have access to the patient's medical history and appointment records.
Always answer based on the provided context. Be empathetic, clear, and precise.
Never fabricate medical information. If unsure, advise the patient to consult their doctor.
When discussing medications, always mention potential side effects or interactions if relevant.`;

/**
 * Answer a patient question using RAG over their appointment history.
 *
 * Only the explicit `question` text is sent to Gemini — chat `history` is
 * passed as structured conversation context, not re-synthesized into audio
 * or used for any purpose other than maintaining conversation coherence.
 */
export async function ragChat(
  patientId: string,
  question: string,
  history: ChatMessage[] = [],
): Promise<{ answer: string; sources: string[] }> {
  const relevantChunks = await retrieveRelevantChunks(patientId, question);

  const contextBlock =
    relevantChunks.length > 0
      ? `\n\nRelevant medical history context:\n${relevantChunks
          .map(
            (c, i) =>
              `[Context ${i + 1} - Appointment ${c.appointmentId}]:\n${c.text}`,
          )
          .join("\n\n")}`
      : "";

  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro",
    systemInstruction: SYSTEM_PROMPT + contextBlock,
  });

  const geminiHistory = history.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));

  const chat = model.startChat({ history: geminiHistory });

  try {
    const result = await withTimeoutPromise(
      chat.sendMessage(question),
      CHAT_TIMEOUT_MS,
      PROVIDER,
    );
    const answer = result.response.text();
    const sources = [...new Set(relevantChunks.map((c) => c.appointmentId))];
    return { answer, sources };
  } catch (err) {
    if (err instanceof ExternalApiError) throw err;
    throw new ExternalApiError(
      `Gemini chat failed: ${err instanceof Error ? err.message : String(err)}`,
      "PROVIDER_ERROR",
      PROVIDER,
      undefined,
      false,
    );
  }
}
