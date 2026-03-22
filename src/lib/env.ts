/**
 * Centralized environment variable validation for Momentum backend.
 *
 * All required env vars are validated on first access using Zod.
 * Any missing variable produces a clear, actionable error message
 * that names the missing variable and explains where to set it.
 */

import { z } from "zod";

const envSchema = z
  .object({
    // ─── Auth ────────────────────────────────────────────────────────────────
    JWT_SECRET: z.string().min(32).optional(),
    NEXTAUTH_SECRET: z.string().min(32).optional(), // legacy fallback

    // ─── AWS S3 ──────────────────────────────────────────────────────────────
    AWS_ACCESS_KEY_ID: z
      .string()
      .min(1, "AWS_ACCESS_KEY_ID is required for S3 access"),
    AWS_SECRET_ACCESS_KEY: z
      .string()
      .min(1, "AWS_SECRET_ACCESS_KEY is required for S3 access"),
    AWS_S3_BUCKET_NAME: z
      .string()
      .min(1, "AWS_S3_BUCKET_NAME is required for S3 access"),
    AWS_REGION: z.string().min(1).default("us-east-1"),

    // ─── AI Services ──────────────────────────────────────────────────────────
    PERPLEXITY_API_KEY: z
      .string()
      .min(1, "PERPLEXITY_API_KEY is required for appointment summarization"),
    GEMINI_API_KEY: z
      .string()
      .min(1, "GEMINI_API_KEY is required for RAG and forms"),
    ELEVENLABS_API_KEY: z
      .string()
      .min(1, "ELEVENLABS_API_KEY is required for text-to-speech"),
    ELEVENLABS_VOICE_ID: z.string().optional(),

    // ─── OMI Webhook ──────────────────────────────────────────────────────────
    OMI_WEBHOOK_SECRET: z
      .string()
      .min(
        1,
        "OMI_WEBHOOK_SECRET is required for webhook signature verification",
      ),

    // ─── Cross-origin / CORS (Vercel frontend <-> Railway backend) ──────────────
    //
    // CORS_ALLOWED_ORIGINS: comma-separated list of exact origins the browser
    //   is permitted to call. Set in Railway for production.
    //   e.g. "https://momentum.vercel.app,https://momentum-pr-42.vercel.app"
    //   Local dev origins (localhost 3000/3001/5173) are always allowed and do
    //   not need to be listed here.
    //
    // CORS_ALLOW_CREDENTIALS: set to "true" only when the frontend needs to send
    //   cookies or HTTP authentication credentials alongside requests (e.g.
    //   session-cookie auth). Leave unset or "false" for the default Bearer JWT
    //   model which does not require credentials mode.
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    CORS_ALLOW_CREDENTIALS: z
      .enum(["true", "false"])
      .optional()
      .default("false"),

    // ─── Runtime ──────────────────────────────────────────────────────────────
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  })
  .refine((data) => data.JWT_SECRET !== undefined || data.NEXTAUTH_SECRET !== undefined, {
    message:
      "JWT_SECRET must be set (min 32 characters). " +
      "Copy .env.example to .env.local and fill in all required values.",
    path: ["JWT_SECRET"],
  });

type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Reset the singleton cache so the next call to getEnv() re-reads process.env.
 *
 * @internal ONLY use this in tests — never in production code.
 */
export function resetEnvCache(): void {
  _env = null;
}

/**
 * Returns the validated environment config. Validates once on first call;
 * subsequent calls return the cached result.
 * Throws a descriptive error if any required variable is missing or invalid.
 */
export function getEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `[Momentum] Missing or invalid environment variables:\n${missing}\n\n` +
        `Copy .env.example to .env.local and fill in all required values.`,
    );
  }

  _env = result.data;
  return _env;
}
