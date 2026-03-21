# MediPlan.ai

**Your Personal Sovereign Health AI** — understand every appointment, manage prescriptions, and take control of your health journey.

MediPlan.ai is the patient-facing cloud version of the [plan.ai](https://plan.ai) sovereign AI infrastructure philosophy: privacy-first, no unnecessary data sharing, and compounding personal health intelligence over time.

---

## Architecture

```
Patient ──► OMI Wearable ──► POST /api/webhook/omi
                                     │
                              ┌──────▼──────┐
                              │  Perplexity │  (appointment summarization)
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │  AWS S3     │  (encrypted patient data store)
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │  Gemini RAG │  (embedding index + Q&A)
                              └─────────────┘
```

---

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Create patient account |
| `POST` | `/api/auth/login` | Authenticate and receive JWT |
| `GET` | `/api/auth/me` | Get current patient profile |

All authenticated endpoints require `Authorization: Bearer <token>`.

### Appointments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/appointments` | List all appointments |
| `POST` | `/api/appointments` | Create appointment manually |
| `GET` | `/api/appointments/:id` | Get single appointment |
| `PATCH` | `/api/appointments/:id` | Update appointment |
| `DELETE` | `/api/appointments/:id` | Delete appointment |
| `POST` | `/api/appointments/:id/transcript` | Upload raw transcript |
| `POST` | `/api/appointments/:id/summarize` | Trigger AI summarization |

### AI Features

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/chat` | RAG-powered Q&A over health history |
| `POST` | `/api/voice` | Text-to-speech (returns MP3) |
| `POST` | `/api/paperwork` | Auto-fill medical forms |

### Device Webhook

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/webhook/omi` | OMI wearable device transcript receiver |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check for Railway |
| `GET` | `/api/user/profile` | Get patient profile |
| `PATCH` | `/api/user/profile` | Update patient profile |

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

| Variable | Description |
|----------|-------------|
| `NEXTAUTH_SECRET` | JWT signing secret (min 32 chars) |
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `AWS_REGION` | S3 bucket region (e.g. `us-east-1`) |
| `AWS_S3_BUCKET_NAME` | S3 bucket for patient data |
| `PERPLEXITY_API_KEY` | Perplexity API key (summarization) |
| `GEMINI_API_KEY` | Google Gemini API key (RAG + forms) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (TTS) |
| `ELEVENLABS_VOICE_ID` | Voice ID (optional, defaults to Rachel) |
| `OMI_WEBHOOK_SECRET` | HMAC secret for OMI webhook verification |

---

## Tech Stack

- **Framework**: Next.js 16 (App Router) + TypeScript
- **Styling**: Tailwind CSS
- **Storage**: AWS S3 (AES-256 encrypted, HIPAA-aligned)
- **Auth**: JWT (jsonwebtoken + bcryptjs)
- **AI — Summaries**: Perplexity `llama-3.1-sonar-large-128k-online`
- **AI — RAG / Q&A**: Google Gemini 1.5 Pro + `text-embedding-004`
- **AI — Voice**: ElevenLabs Turbo v2
- **Deployment**: Railway (Dockerfile / standalone output)

---

## Local Development

```bash
npm install
cp .env.example .env.local   # fill in your keys
npm run dev
```

## Deployment (Railway)

1. Push this repository to GitHub
2. Create a new Railway project and connect the repo
3. Add all environment variables from `.env.example`
4. Railway auto-detects the `Dockerfile` and deploys

---

## Security

- All S3 objects are stored with `ServerSideEncryption: AES256`
- Passwords are hashed with bcrypt (13 rounds — OWASP healthcare recommendation)
- JWTs expire after 7 days
- OMI webhook payloads are verified with HMAC-SHA256
- Security headers applied to all routes (HSTS, X-Frame-Options, etc.)
- Patient data is namespaced per `patientId` in S3 — cross-patient access is impossible at the API level

---

## License

Private — MomentumAI / CMomentumAI
