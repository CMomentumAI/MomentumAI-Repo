# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added
- **CORS / cross-origin support** for Vercel frontend → Railway backend deployment
  - `src/lib/cors.ts`: centralised origin allowlist with `getAllowedOrigins()`, `isOriginAllowed()`, `buildCorsHeaders()`, `buildPreflightHeaders()`
  - `src/proxy.ts`: handles `OPTIONS` preflight (returns 204), attaches `Access-Control-Allow-Origin` + `Vary: Origin` to all `/api/**` responses for allowed origins
  - `FRONTEND_URL` env var: set in Railway to the Vercel origin (e.g. `https://momentum.vercel.app`)
  - `ADDITIONAL_ORIGINS` env var: comma-separated list for preview/staging Vercel deployments
  - `docs/frontend-integration.md`: complete integration contract for the Vercel frontend (auth flow, fetch patterns, audio handling, presigned URLs, local dev, production, preview deployments, security notes)
  - 25 new CORS unit tests in `src/test/unit/cors.test.ts`
- `POST /api/auth/logout` — revokes the caller's JWT via an in-process token denylist
- `GET /api/appointments/:id/transcript` — returns a 5-minute presigned S3 URL for the raw transcript (replaces inline PHI in API responses)
- `GET /api/appointments/:id/summary` — returns a presigned S3 URL for the structured summary JSON
- Pagination on `GET /api/appointments`: new `?page=&limit=` params; response shape is now `{ items, pagination }` with `total`, `page`, `limit`, `pages`, `hasNext`, `hasPrev`
- Per-user rate limiting (`apiLimiter`, 120 req/min) applied to `/api/chat`, `/api/voice`, `/api/paperwork`
- `scripts/cleanup-s3-deleted.ts` — maintenance script that purges S3 artifacts for soft-deleted appointments (dry-run by default, `--delete` to execute)
- `AppointmentSummaryView` type — safe appointment view without `rawTranscript`, plus `hasTranscript: boolean`
- `PaginatedResponse<T>` generic type for paginated list endpoints
- `src/lib/token-denylist.ts` — in-process JWT denylist with TTL-based auto-expiry
- `_resetRateLimitersForTesting()` and `RateLimiter.reset()` for test isolation
- Integration tests for auth, appointments, and webhook routes (offline — all providers mocked)
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) — lint, build, test on every push/PR
- `docs/openapi.yaml` — OpenAPI 3.1 spec for all 17 API endpoints
- `docs/ops.md` — logging format, monitoring recommendations, S3 backup/disaster-recovery guide, S3 lifecycle rule examples
- `CONTRIBUTING.md` — development setup, code conventions, testing guide
- `@vitest/coverage-v8` + `test:coverage` script for coverage reporting

### Changed
- All appointment API responses (`GET /api/appointments`, `GET /api/appointments/:id`, `PATCH`, `POST`, summarize, transcript upload) now strip `rawTranscript` from the response body and add `hasTranscript: boolean`. Access the transcript via the new presigned-URL endpoint.
- `GET /api/appointments` response shape changed: `data` is now `{ items: Appointment[], pagination: {...} }` instead of `Appointment[]`
- `bcryptjs` salt rounds reduced to 1 when `NODE_ENV=test` (was always 13). Production is unchanged.
- Pagination Zod schema uses `z.preprocess` to handle `null` searchParams correctly
- ESLint config now disables `no-explicit-any` in `src/test/` and `scripts/` directories

### Removed
- Deprecated `getPresignedUrl()` alias from `src/lib/s3.ts` (no callers remained; use `getPresignedDownloadUrl()`)

### Fixed
- `audioS3Key` on the `Appointment` type is now documented as reserved for hardware-captured recordings, not TTS-generated audio (which is streamed on-demand)

---

## [0.1.0] — Initial Release

### Added
- Next.js 16 App Router backend on Railway/Docker
- AWS S3 as single data store (user records, appointments, transcripts, summaries, embeddings)
- JWT-based auth (register, login) with bcrypt password hashing (13 rounds)
- Appointment CRUD with soft-delete
- OMI wearable webhook with HMAC-SHA256 verification and session idempotency
- AI pipeline: Perplexity summarization → Gemini RAG indexing (via `after()`)
- RAG chat (`/api/chat`) with Gemini 1.5 Pro
- Text-to-speech (`/api/voice`) via ElevenLabs
- Medical form auto-fill (`/api/paperwork`) via Gemini
- Structured NDJSON logging with PHI key redaction
- In-memory sliding-window rate limiter (auth endpoints: 10 req/min/IP)
- `X-Request-ID` correlation across all API requests
- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
- 126 unit tests (auth, resilience, S3 validation, env, webhook signature)
- `scripts/seed.ts` — fictional demo patient + 2 synthetic appointments
