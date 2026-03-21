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
import { requireAuth, successResponse, errorResponse } from "@/lib/api-helpers";

const ChatSchema = z.object({
  message: z.string().min(1, "Message cannot be empty").max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .max(20, "History is limited to 20 messages")
    .optional()
    .default([]),
});

export async function POST(request: NextRequest) {
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

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

    return successResponse({ answer, sources });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Chat failed";
    console.error("[chat:POST]", error);

    if (message.includes("GEMINI_API_KEY")) {
      return errorResponse("AI service is not configured", 503);
    }

    return errorResponse("Failed to process your question", 500);
  }
}
