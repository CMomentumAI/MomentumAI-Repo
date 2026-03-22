/**
 * Global test setup — runs once before all test files.
 *
 * Populates process.env with the minimum env vars required by the app's
 * Zod validation schema so that getEnv() succeeds in tests that don't
 * need to exercise the validation itself.
 *
 * Tests that need to test missing/invalid env vars should:
 *   1. Import resetEnvCache from @/lib/env
 *   2. Delete / mutate process.env keys they want to vary
 *   3. Call resetEnvCache() before getEnv() so the singleton re-validates
 *   4. Restore original values in afterEach/afterAll
 */

process.env.NODE_ENV = "test";

// ─── Auth ──────────────────────────────────────────────────────────────────────
// 32-char minimum required by the schema
process.env.JWT_SECRET = "test-jwt-secret-32-chars-exactly!";

// ─── AWS S3 ───────────────────────────────────────────────────────────────────
process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
process.env.AWS_S3_BUCKET_NAME = "test-bucket";
process.env.AWS_REGION = "us-east-1";

// ─── AI services ─────────────────────────────────────────────────────────────
process.env.PERPLEXITY_API_KEY = "pplx-test-key";
process.env.GEMINI_API_KEY = "gemini-test-key";
process.env.ELEVENLABS_API_KEY = "elevenlabs-test-key";

// ─── Webhook ──────────────────────────────────────────────────────────────────
// 32-char minimum for meaningful HMAC secrets
process.env.OMI_WEBHOOK_SECRET = "test-webhook-secret-32-chars-ok!";
