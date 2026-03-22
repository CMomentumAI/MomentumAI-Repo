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

// ─── Google Cloud Storage ─────────────────────────────────────────────────────
// These are dummy values — the GCS client is mocked in tests so no real
// Google Cloud calls are made.
process.env.GCS_BUCKET_NAME = "test-bucket";
process.env.GCS_PROJECT_ID = "test-project";

// ─── AI services ─────────────────────────────────────────────────────────────
process.env.PERPLEXITY_API_KEY = "pplx-test-key";
process.env.GEMINI_API_KEY = "gemini-test-key";
process.env.ELEVENLABS_API_KEY = "elevenlabs-test-key";

// ─── Webhook ──────────────────────────────────────────────────────────────────
// 32-char minimum for meaningful HMAC secrets
process.env.OMI_WEBHOOK_SECRET = "test-webhook-secret-32-chars-ok!";
