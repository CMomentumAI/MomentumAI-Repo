# Momentum — Personal Sovereign Health AI

**Understand every appointment. Manage prescriptions. Take control of your health journey.**

Momentum is a privacy-first health intelligence backend. Patients connect their OMI wearable device to automatically capture appointment transcripts, which are summarized by AI and indexed for conversational retrieval. All data is stored in the patient's own AWS S3 bucket — no third-party health databases.

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

**Storage note:** Railway containers use an ephemeral local filesystem — any files written to disk at runtime are wiped on every redeploy or restart. All persistent patient data (transcripts, summaries, embeddings, audio, user records) is stored exclusively in AWS S3. Do not write persistent data to the local filesystem.

---

## API Reference

### Authentication

All authenticated endpoints require the header: `Authorization: Bearer <token>`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Create patient account; returns `{ patient, token }` |
| `POST` | `/api/auth/login` | Authenticate; returns `{ patient, token }` |
| `GET` | `/api/auth/me` | Current patient profile (no password hash) |

### Appointments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/appointments` | List all non-deleted appointments (sorted by date desc) |
| `POST` | `/api/appointments` | Create appointment manually |
| `GET` | `/api/appointments/:id` | Fetch a single appointment |
| `PATCH` | `/api/appointments/:id` | Update title, doctorName, specialty, date, notes |
| `DELETE` | `/api/appointments/:id` | Soft-delete (status → "deleted") |
| `POST` | `/api/appointments/:id/transcript` | Upload raw transcript text (max 100 KB) |
| `POST` | `/api/appointments/:id/summarize` | Trigger AI summarization + RAG indexing |

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

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health + config readiness check for Railway |
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

To populate the database with a fictional demo patient and two synthetic appointments (no AI API keys needed for the seed — summaries are pre-written):

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

## Deployment (Railway)

### Quick deploy

1. Push this repository to GitHub.
2. Create a Railway project → **New Service → GitHub Repo**.
3. In **Settings → Variables**, add every variable from `.env.example`.
4. Railway auto-detects the `Dockerfile` and builds a production image.
5. Confirm the deploy succeeds by checking `https://your-app.railway.app/api/health`.

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

### Deploy configuration (railway.toml)

| Setting | Value | Why |
|---------|-------|-----|
| Builder | `DOCKERFILE` | Multi-stage build; standalone Next.js output |
| Health check | `/api/health` | Confirms app + env config before routing traffic |
| Health timeout | 300 s | Next.js standalone server needs time to warm up |
| Restart policy | `ON_FAILURE` (max 3) | Recover from crashes; stop looping on misconfiguration |

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
curl -X POST https://your-app.railway.app/api/webhook/omi \
  -H "Content-Type: application/json" \
  -H "X-OMI-Signature: $SIG" \
  -d "$BODY"
```

The webhook returns `202 Accepted` immediately. Processing (summarization + RAG indexing) runs in the background via `after()` and completes within 30–60 seconds for typical transcripts. Check the appointment's `status` field: `pending` → `summarized` (or `error`).

**Idempotency:** Duplicate `session_id` deliveries are detected using a per-patient session index in S3 and return a `200` with the existing appointment ID.

---

## Logging

All application logs are emitted as newline-delimited JSON to stdout/stderr. Railway's log collector captures them automatically.

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
| Deployment | Railway (Dockerfile, `output: "standalone"`) |
| Testing | Vitest 4 — 126 tests, all offline |

---

## Known Limitations

- **Single-instance only:** The in-memory rate limiter and S3 read-then-write index pattern are not safe for multiple replicas. Scale horizontally only after migrating to a shared store (Redis, DynamoDB, or a relational DB).
- **No token revocation:** JWTs are stateless — a leaked token is valid until the 7-day TTL expires. Mitigation: shorten the TTL or add a Redis-backed denylist.
- **Background work survives SIGTERM but not SIGKILL:** `after()` callbacks (AI pipeline) wait for graceful shutdown on Railway deploy. If the SIGKILL deadline is reached mid-summarization, the appointment stays in `status: "pending"`. Recover by calling `POST /api/appointments/:id/summarize`.
- **S3 key migration required on first deploy:** All keys gained a `{NODE_ENV}/` prefix. Existing data written before this change is inaccessible without a one-time S3 copy/rename.
- **No soft-delete cleanup:** Deleted appointments are soft-deleted (status flag only); their S3 artifacts (transcripts, summaries, audio) are not removed. A data-retention job is needed for regulatory compliance.

---

## License

Private — MomentumAI / CMomentumAI
