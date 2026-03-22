# Contributing to Momentum

## Architecture overview

Momentum is a **backend-only REST API** deployed on Railway. All data lives in **AWS S3** as JSON objects — there is no relational database. See `docs/openapi.yaml` for the full API contract and `docs/ops.md` for operational guidance.

Key source directories:
```
src/
  app/api/        — Next.js App Router route handlers (one file per route)
  lib/            — Shared service libraries (S3, auth, AI providers, logging)
  test/           — Test setup + unit + integration tests
  types/          — Shared TypeScript interfaces
```

## Development setup

```bash
git clone <repo>
npm install
cp .env.example .env.local   # fill in all required values
npm run dev                  # http://localhost:3000
```

Refer to the README for full environment variable documentation and AWS S3 IAM setup.

## Code conventions

### S3 key construction
**Always** use `buildS3Key(patientId, category, filename)` or `buildSystemKey(subpath)`. Never construct raw S3 key strings — the builders validate inputs and add the env prefix.

### Error handling
- Throw `S3StorageError` (from `@/lib/s3`) for storage failures
- Throw `ExternalApiError` (from `@/lib/resilience`) for AI provider failures
- In route handlers, catch errors and call `logger.error()` then return `errorResponse("message", 500)`

### PHI protection
- Never log `rawTranscript`, `summary`, chat messages, or patient context
- Use `toSafeAppointment()` before returning appointments in API responses
- Use `logger` (from `@/lib/logger`) — it auto-redacts sensitive keys

### Ownership enforcement
- Every patient-scoped route must call `requireAuth()` and `requireOwnership()`
- `getAppointment(patientId, id)` scopes the S3 key to patientId — use it consistently
- Check the audit section in the route handler tests if in doubt

### New routes checklist
- [ ] Call `requireAuth(request)` at the top
- [ ] Call `requireOwnership(user, patientId)` for patient-scoped resources
- [ ] Strip `rawTranscript` from any appointment returned in responses (`toSafeAppointment`)
- [ ] Add structured logging: `logger.info(tag, message, { requestId, userId, ... })`
- [ ] Apply `apiLimiter.check(user.sub)` for AI-heavy endpoints
- [ ] Return consistent `successResponse` / `errorResponse` shapes

## Testing

```bash
npm test           # Run all tests (offline — S3 and AI providers mocked)
npm run test:watch # TDD watch mode
npm run test:coverage  # Generate coverage report in coverage/
```

### Writing tests
- Unit tests go in `src/test/unit/`
- Integration tests go in `src/test/integration/`
- S3 is mocked in integration tests using `vi.hoisted` + `vi.mock("@/lib/s3", ...)`
- AI providers (Perplexity, Gemini, ElevenLabs) are mocked via `vi.stubGlobal("fetch", ...)` or `vi.mock("@/lib/...")`
- The `_resetRateLimitersForTesting()` and `_resetDenylistForTesting()` helpers are available for test isolation

## Pull request process

1. Run `npm run lint && npm run build && npm test` before submitting
2. Keep PRs focused — one logical change per PR
3. Update `CHANGELOG.md` with a brief entry under `[Unreleased]`
4. Update `docs/openapi.yaml` if any route signatures change
5. Security-sensitive changes (auth, ownership, S3 key construction) require careful review

## Local S3 alternative

The project does not ship a local S3 emulator (localstack). For local development, use a real S3 bucket in a personal AWS account with the `development/` prefix (set automatically when `NODE_ENV !== production`). Dev and prod data are isolated by the prefix within a shared bucket.

## Deployment

Push to your branch → Railway auto-builds via Dockerfile. Environment variables must be set in the Railway dashboard before the first deploy. See README for the full deployment guide.
