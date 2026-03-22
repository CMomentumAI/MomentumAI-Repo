/**
 * POST /api/chat
 *
 * RAG-powered Q&A chat using Gemini 1.5 Pro over the patient's appointment history.
 *
 * Request body:
 *  { message: string, history?: { role: "user" | "assistant", content: string }[] }
 *
 * Response:
 *  { answer: string, sources: string[] }
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { ragChat } from "@/lib/gemini";
import {
  requireAuth,
  successResponse,
  errorResponse,
  rateLimitResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";
import { apiLimiter } from "@/lib/rate-limit";

const ChatSchema = z.object({
  message: z.string().min(1, "Message cannot be empty").max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        // Per-message content cap prevents unbounded payloads when 20 messages
        // are each padded with large strings.
        content: z.string().max(2000, "Each history message may not exceed 2000 characters"),
      }),
    )
    .max(20, "History is limited to 20 messages")
    .optional()
    .default([]),
});

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  // Per-user rate limit for AI-heavy endpoints (120 req/60s per userId).
  const rl = apiLimiter.check(user.sub);
  if (!rl.allowed) {
    logger.warn("chat:POST", "Rate limit exceeded", { requestId, userId: user.sub });
    return rateLimitResponse(rl.resetAt);
  }

  try {
    const body = await request.json();
    const parsed = ChatSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const { message, history } = parsed.data;

    const { answer, sources } = await ragChat(user.sub, message, history);

    logger.info("chat:POST", "Chat request handled", {
      requestId,
      userId: user.sub,
      historyLength: history.length,
      sourceCount: sources?.length ?? 0,
    });

    return successResponse({ answer, sources });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Chat failed";
    logger.error("chat:POST", "Chat request failed", error, {
      requestId,
      userId: user.sub,
    });

    if (message.includes("GEMINI_API_KEY")) {
      return errorResponse("AI service is not configured", 503);
    }

    return errorResponse("Failed to process your question", 500);
  }
}
