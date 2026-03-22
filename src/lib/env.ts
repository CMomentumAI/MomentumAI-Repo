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

    // ─── Cross-origin deployment (Vercel frontend <-> Railway backend) ──────────
    //
    // FRONTEND_URL: canonical Vercel origin, e.g. https://momentum.vercel.app
    //   Set in Railway env vars so the backend knows which origin to allow.
    //   If absent, only the hardcoded localhost dev origins are allowed.
    //
    // ADDITIONAL_ORIGINS: comma-separated extra origins for preview/staging.
    //   e.g. "https://momentum-pr-42.vercel.app,https://staging.example.com"
    FRONTEND_URL: z.string().url().optional(),
    ADDITIONAL_ORIGINS: z.string().optional(),

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
