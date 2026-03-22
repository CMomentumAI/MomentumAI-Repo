# Momentum — Personal Sovereign Health AI

**Understand every appointment. Manage prescriptions. Take control of your health journey.**

Momentum is a privacy-first health intelligence Next.js application. The UI and backend API live in one deployable app, with route handlers under `src/app/api/**`. Patients connect their OMI wearable device to automatically capture appointment transcripts, which are summarized by AI and indexed for conversational retrieval. All data is stored in the patient's own AWS S3 bucket — no third-party health databases.

---

## Architecture

```
OMI Wearable ──► POST /api/webhook/omi   (HMAC-SHA256 verified)
                         │
              ┌──────────▼──────────┐
              │  AWS S3             │  Patient data store
              │  AES-256 encrypted  │  (transcripts, summaries,
              │  per-patient prefix │   embeddings, forms)
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐   ┌──────────────────────┐
              │  Perplexity         │   │  Google Gemini       │
              │  Appointment        │   │  RAG embedding index  │
              │  summarization      │   │  + chat completions   │
              └─────────────────────┘   └──────────────────────┘
                                                  │
                                        POST /api/chat
                                        POST /api/paperwork
                                        POST /api/voice (ElevenLabs)
```

**Storage note:** Vercel/Next.js runtimes are ephemeral. All persistent patient data (transcripts, summaries, embeddings, audio, user records) is stored exclusively in AWS S3. Do not write persistent data to the local filesystem.

---

## API Reference

### Authentication

All authenticated endpoints require the header: `Authorization: Bearer <token>`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Create patient account; returns `{ patient, token }` |
| `POST` | `/api/auth/login` | Authenticate; returns `{ patient, token }` |
| `POST` | `/api/auth/logout` | Revoke current JWT (adds to in-process denylist) |
| `GET` | `/api/auth/me` | Current patient profile (no password hash) |

### Appointments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/appointments` | List appointments, paginated (`?page=1&limit=20`); returns `{ items, pagination }` |
| `POST` | `/api/appointments` | Create appointment manually |
| `GET` | `/api/appointments/:id` | Fetch a single appointment (rawTranscript omitted) |
| `PATCH` | `/api/appointments/:id` | Update title, doctorName, specialty, date, notes |
| `DELETE` | `/api/appointments/:id` | Soft-delete (status → "deleted") |
| `POST` | `/api/appointments/:id/transcript` | Upload raw transcript text (max 100 KB) |
| `GET` | `/api/appointments/:id/transcript` | Get 5-min presigned S3 URL to download transcript |
| `POST` | `/api/appointments/:id/summarize` | Trigger AI summarization + RAG indexing |
| `GET` | `/api/appointments/:id/summary` | Get 5-min presigned S3 URL to download summary JSON |

### AI Features

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/chat` | RAG-powered Q&A over patient's appointment history |
| `POST` | `/api/voice` | Text-to-speech; returns `audio/mpeg` bytes |
| `POST` | `/api/paperwork` | Auto-fill medical forms using Gemini |

### Webhook

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/webhook/omi` | Receive OMI device transcript (HMAC-SHA256 required) |
| `POST` | `/api/webhooks/omi` | Alias for `/api/webhook/omi` (same behavior) |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health + config readiness check |
| `GET` | `/api/user/profile` | Patient profile |
| `PATCH` | `/api/user/profile` | Update name / date of birth |

---

## Environment Variables

Copy `.env.example` to `.env.local` for local development:

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes (or `NEXTAUTH_SECRET`) | JWT signing secret — min 32 chars. Generate: `openssl rand -base64 32` |
| `NEXTAUTH_SECRET` | Fallback | Legacy alias for `JWT_SECRET` |
| `AWS_ACCESS_KEY_ID` | Yes | AWS IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS IAM secret key |
| `AWS_REGION` | Yes | S3 bucket region (e.g. `us-east-1`) |
| `AWS_S3_BUCKET_NAME` | Yes | S3 bucket name for patient data |
| `PERPLEXITY_API_KEY` | Yes | Perplexity API key (appointment summarization) |
| `GEMINI_API_KEY` | Yes | Google Gemini API key (RAG + forms) |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key (TTS audio) |
| `ELEVENLABS_VOICE_ID` | No | ElevenLabs voice ID (defaults to Rachel) |
| `OMI_WEBHOOK_SECRET` | Yes | HMAC-SHA256 secret shared with OMI cloud |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed origins for optional cross-origin browser callers. Leave unset for same-origin deployments. Localhost dev ports (3000/3001/5173) are always allowed. |
| `CORS_ALLOW_CREDENTIALS` | No | `"true"` to send `Access-Control-Allow-Credentials: true` (only needed for cookie/session auth; leave `"false"` for Bearer JWT). |

---

## AWS S3 Setup

1. **Create a private S3 bucket** in your AWS account. Block all public access.
2. **Enable server-side encryption** — AES-256 (SSE-S3) is sufficient; SSE-KMS adds cost with no benefit here since the app manages per-patient key isolation at the object-key level.
3. **Create an IAM user** with the following policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR-BUCKET-NAME",
        "arn:aws:s3:::YOUR-BUCKET-NAME/*"
      ]
    }
  ]
}
```

4. Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_S3_BUCKET_NAME` in your environment.

**Key structure inside the bucket:**

```
development/
  patients/{userId}/
    appointments/        appointment records + index
    transcripts/         raw transcript text files
    summaries/           structured summary JSON
    embeddings/          per-patient RAG embedding index
  system/
    users/               user records + email index

production/
  ...identical structure...
```

The `development/` vs `production/` prefix is set automatically based on `NODE_ENV`, so dev and prod can safely share one bucket.

---

## Local Development

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local and fill in all required values

# Start the dev server (hot-reload)
npm run dev
```

The app runs at `http://localhost:3000`. All API endpoints are at `/api/**`.

### Seed demo data

To populate S3 with a fictional demo patient and two synthetic appointments (no AI API keys needed for the seed — summaries are pre-written):

```bash
npm run seed
```

Demo credentials:
- **Email:** `demo@momentum.health`
- **Password:** `Demo1234!`

After seeding, POST to `/api/appointments/:id/summarize` with the demo user's token to build the RAG embedding index (requires `GEMINI_API_KEY`).

### Run tests

```bash
npm test           # single run
npm run test:watch # watch mode for TDD
```

Tests are fully offline — all S3 and AI provider calls are mocked.

---

## Deployment (Vercel)

Momentum is designed to deploy as a **single Next.js app** on Vercel (frontend + backend route handlers together).

### Quick deploy

1. Push this repository to GitHub.
2. Import the repo into Vercel.
3. Add all required variables from `.env.example` in **Project Settings → Environment Variables**.
4. Deploy and confirm health at `https://your-app.vercel.app/api/health`.

### Health check response

```json
{
  "status": "ok",
  "service": "Momentum",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "version": "0.1.0",
  "config": {
    "auth": true,
    "storage": true,
    "ai_summarization": true,
    "ai_rag": true,
    "ai_tts": true,
    "webhook": true
  }
}
```

If `status` is `"misconfigured"`, check which `config` booleans are `false` and add the corresponding env vars.

### Optional Railway deployment

`railway.toml` and the Dockerfile are still present for teams that also deploy on Railway, but Vercel is the primary target architecture for this repository.

---

## OMI Webhook Testing

To simulate an OMI wearable payload:

```bash
# Set your webhook secret
SECRET="your-omi-webhook-secret"
BODY='{"session_id":"test-session-001","patient_id":"<userId>","transcript":[{"text":"Hello doctor","speaker":"SPEAKER_00","speaker_id":0,"is_user":true,"start":0,"end":2},{"text":"Hello! How are you feeling?","speaker":"SPEAKER_01","speaker_id":1,"is_user":false,"start":2,"end":5}],"started_at":"2025-01-01T10:00:00Z","finished_at":"2025-01-01T10:30:00Z"}'

# Compute HMAC-SHA256 signature
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

# Send the webhook
curl -X POST https://your-app.vercel.app/api/webhook/omi \
  -H "Content-Type: application/json" \
  -H "X-OMI-Signature: $SIG" \
  -d "$BODY"
```

The webhook returns `202 Accepted` immediately. Processing (summarization + RAG indexing) runs in the background via `after()` and completes within 30–60 seconds for typical transcripts. Check the appointment's `status` field: `pending` → `summarized` (or `error`).

**Idempotency:** Duplicate `session_id` deliveries are detected using a per-patient session index in S3 and return a `200` with the existing appointment ID.

---

## CORS Configuration

For same-origin Vercel deployments, no CORS configuration is needed for app UI
requests to `/api/**`. CORS is handled centrally in `src/proxy.ts` for optional
cross-origin browser callers.

### Local development

No configuration required. `http://localhost:3000`, `http://localhost:3001`, and
`http://localhost:5173` are always in the allowlist.

### Optional cross-origin production setup

Set this if an external browser origin must call your API:

```
CORS_ALLOWED_ORIGINS=https://momentum.vercel.app
```

For multiple origins (preview deployments, staging):

```
CORS_ALLOWED_ORIGINS=https://momentum.vercel.app,https://momentum-pr-42.vercel.app
```

### Credentials (cookies/session auth)

The default auth model is **stateless Bearer JWT** — no credentials mode is
needed and `CORS_ALLOW_CREDENTIALS` should remain `false`.

If you add cookie-based auth for cross-origin callers in the future:

1. Set `CORS_ALLOW_CREDENTIALS=true`.
2. Update the frontend fetch calls to include `credentials: "include"`.
3. Ensure `CORS_ALLOWED_ORIGINS` is set — `*` is never used when credentials
   are enabled (the exact request origin is always echoed instead).

### How it works

| Step | What happens |
|------|--------------|
| Browser sends `OPTIONS` preflight | Proxy returns 204 with `Access-Control-Allow-Origin`, methods, headers, max-age |
| Browser sends actual request | Proxy attaches `Access-Control-Allow-Origin` + `Vary: Origin` to the response |
| Unknown origin | Preflight returns 403; actual response has no CORS headers (browser blocks it) |
| Error responses | Same CORS headers are attached (proxy wraps all responses, not just 2xx) |

For the complete frontend integration guide see `docs/frontend-integration.md`.

---

## Logging

All application logs are emitted as newline-delimited JSON to stdout/stderr.

Log format:
```json
{ "ts": "...", "level": "info|warn|error", "tag": "route:method", "message": "...", "requestId": "...", "userId": "..." }
```

**PHI protection:** The following keys are automatically redacted from all log output: `password`, `token`, `transcript`, `rawTranscript`, `authorization`, `secret`, `apiKey`, `signedUrl`, `presignedUrl`. Never log raw transcript text, patient names, or medical data directly.

---

## Security

| Control | Details |
|---------|---------|
| Auth | Stateless JWT — 7-day expiry, HS256 with a min-32-char secret |
| Password storage | bcrypt, 13 salt rounds (OWASP healthcare recommendation) |
| S3 encryption | AES-256 server-side encryption on every object |
| S3 isolation | All keys prefixed `{env}/patients/{userId}/` — cross-patient access impossible at the storage layer |
| Webhook | HMAC-SHA256 with `timingSafeEqual` — timing-attack resistant |
| Security headers | HSTS, X-Frame-Options: DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |
| Rate limiting | Auth endpoints: 10 req/min per IP (in-memory; single instance) |
| Request IDs | Every API response carries `X-Request-ID` for log correlation |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, standalone output) |
| Language | TypeScript 5 (strict mode) |
| Storage | AWS S3 (no database — all records are JSON objects in S3) |
| Auth | `jsonwebtoken` + `bcryptjs` |
| AI — Summarization | Perplexity `llama-3.1-sonar-large-128k-online` |
| AI — RAG / Q&A | Google Gemini 1.5 Pro + `text-embedding-004` |
| AI — Voice | ElevenLabs `eleven_turbo_v2` |
| Deployment | Vercel (primary), Railway optional |
| Testing | Vitest 4 — 155 tests, all offline |

---

## Known Limitations

- **Single-instance only:** The in-memory rate limiter and S3 read-then-write index pattern are not safe for multiple replicas. Scale horizontally only after migrating to a shared store (Redis, DynamoDB, or a relational DB).
- **In-process token denylist:** `POST /api/auth/logout` revokes a token via an in-memory denylist keyed by `sub:iat`. Clients should also discard the token locally. The denylist **does not survive runtime restarts/redeploys** — after a restart a revoked token is valid again until its 7-day TTL expires. For guaranteed revocation, replace the denylist with a Redis-backed store.
- **Background work is best-effort:** `after()` callbacks (AI pipeline) run outside the response path. If the runtime is terminated mid-summarization, the appointment can remain `status: "pending"`. Recover by calling `POST /api/appointments/:id/summarize`.
- **S3 key migration required on first deploy:** All keys gained a `{NODE_ENV}/` prefix. Existing data written before this change is inaccessible without a one-time S3 copy/rename.
- **Soft-delete leaves S3 artifacts:** Deleted appointments are soft-deleted (status flag only); their S3 artifacts (transcripts, summaries, embeddings) are not removed automatically. Run `npm run cleanup` (dry-run by default, add `--delete` to execute) to purge artifacts for soft-deleted appointments. See `docs/ops.md` for scheduling guidance.

---

## License

Private — MomentumAI / CMomentumAI
