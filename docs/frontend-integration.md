# Momentum Frontend Integration Guide

**Backend:** Railway — `https://api.momentum.railway.app` (example)  
**Frontend:** Vercel — `https://momentum.vercel.app` (example)

---

## Overview

The Momentum API backend runs on Railway; the frontend runs on Vercel. Because
they are on different origins, every browser fetch from the frontend to the
backend is a **cross-origin request**. The backend handles this through the
CORS middleware in `src/proxy.ts`, which applies on every `/api/**` route.

---

## Auth model

Auth is **stateless Bearer JWT**. There are no cookies.

```
Frontend                      Railway backend
  │  POST /api/auth/login       │
  │  { email, password }        │
  │ ─────────────────────────► │
  │                              │  verify credentials
  │  { data: { patient, token } }│
  │ ◄───────────────────────── │
  │                              │
  │  Store token in memory       │
  │  (or localStorage)           │
  │                              │
  │  GET /api/appointments       │
  │  Authorization: Bearer <tok> │
  │ ─────────────────────────► │
  │                              │  verify JWT, return data
  │  { data: { items, ... } }    │
  │ ◄───────────────────────── │
```

**Do NOT use `credentials: "include"`** — there are no cookies to send.
The `Authorization` header is sufficient and does not require credentials mode.

---

## Required HTTP setup

### Base URL

Store the backend URL in a Vercel environment variable:

```bash
# .env.local (local dev)
NEXT_PUBLIC_API_URL=http://localhost:3000   # or 3001, 5173, etc.

# Vercel dashboard (production)
NEXT_PUBLIC_API_URL=https://api.momentum.railway.app
```

### Fetch helper

```typescript
// lib/api.ts

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    // Do NOT include credentials: "include" — Momentum uses Bearer tokens, not cookies.
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error ?? `HTTP ${response.status}`);
  }

  return data.data as T;
}
```

---

## Authentication flow

### Register

```typescript
const result = await apiFetch<{ patient: Patient; token: string }>(
  "/api/auth/register",
  {
    method: "POST",
    body: { email, password, name },
  },
);

// Store the token — in memory is the most secure option:
let authToken: string | null = result.token;
```

### Login

```typescript
const result = await apiFetch<{ patient: Patient; token: string }>(
  "/api/auth/login",
  {
    method: "POST",
    body: { email, password },
  },
);

authToken = result.token;
```

### Logout

```typescript
await apiFetch("/api/auth/logout", { method: "POST" }, authToken);
authToken = null; // discard the token locally too
```

The logout endpoint adds the token to the backend's in-process denylist.
Because the denylist resets on container restart, always discard the token on
the client side as the primary mechanism.

### Authenticated requests

```typescript
// Example: list appointments
const { items, pagination } = await apiFetch<AppointmentsResponse>(
  "/api/appointments?page=1&limit=20",
  { method: "GET" },
  authToken,
);
```

---

## API response shape

All responses follow the same envelope:

```typescript
// Success
{
  success: true,
  data: T,          // varies by endpoint
  message?: string,
}

// Error
{
  success: false,
  error: string,
  details?: unknown, // validation field errors, etc.
}
```

---

## Audio (TTS)

The `/api/voice` endpoint returns binary MP3 bytes, not JSON:

```typescript
const response = await fetch(`${API_URL}/api/voice`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  },
  body: JSON.stringify({ text: "Hello from Momentum." }),
  // No credentials: "include" needed
});

if (!response.ok) throw new Error("TTS failed");

const blob = await response.blob();
const url = URL.createObjectURL(blob);

const audio = new Audio(url);
audio.play();
```

---

## File downloads (transcripts, summaries)

Use the presigned-URL endpoints to download stored files:

```typescript
// 1. Get a 5-minute presigned download URL
const { url } = await apiFetch<{ url: string; expiresInSeconds: number }>(
  `/api/appointments/${id}/transcript`,
  { method: "GET" },
  authToken,
);

// 2. Fetch the file from S3 — this is a direct S3 URL, not the Railway API.
//    No Authorization header needed (it's a pre-signed S3 URL).
//    No CORS issues: S3 is configured to allow the download.
const transcriptText = await fetch(url).then((r) => r.text());
```

> **Note about S3 CORS:** The presigned URL points directly to AWS S3, not to
> the Railway backend. If the Vercel frontend fetches it from the browser (not
> server-side), the S3 bucket must have a CORS policy that allows the Vercel
> origin. Configure this in the S3 bucket's CORS settings:
>
> ```json
> [
>   {
>     "AllowedOrigins": ["https://momentum.vercel.app"],
>     "AllowedMethods": ["GET"],
>     "AllowedHeaders": ["*"],
>     "MaxAgeSeconds": 3600
>   }
> ]
> ```
>
> Alternatively, proxy the download through the frontend's own Next.js API
> route to avoid this requirement.

---

## Webhook (OMI device)

`POST /api/webhook/omi` is called **server-to-server** by the OMI device cloud,
not from the browser. No CORS handling is required for this endpoint, and it is
protected independently by HMAC-SHA256 signature verification.

---

## Error handling reference

| HTTP status | Meaning |
|------------|---------|
| 200 | Success |
| 201 | Created |
| 202 | Accepted (webhook, async processing started) |
| 204 | No Content (preflight response) |
| 400 | Bad request / validation error — check `details` |
| 401 | Unauthorized — token missing, invalid, or revoked |
| 403 | Forbidden — user does not own the requested resource |
| 404 | Not found |
| 409 | Conflict (duplicate email on register) |
| 422 | Unprocessable — e.g. summarize called with no transcript |
| 429 | Rate limited — check `Retry-After` header and back off |
| 500 | Server error |
| 503 | AI service unavailable / unconfigured |

---

## Local development

1. Start the Railway backend locally with `npm run dev` in the backend repo:
   ```bash
   cp .env.example .env.local  # fill in your values
   npm run dev                  # http://localhost:3000
   ```

2. In the Vercel frontend repo, point to the local backend:
   ```bash
   # .env.local in the Vercel frontend repo
   NEXT_PUBLIC_API_URL=http://localhost:3000
   ```

3. `localhost:3000`, `localhost:3001`, and `localhost:5173` are always in the
   backend's CORS allowlist — no extra configuration needed for local dev.

---

## Production deployment

### Railway backend

1. Set `FRONTEND_URL` to your production Vercel URL:
   ```
   FRONTEND_URL=https://momentum.vercel.app
   ```
2. Verify by checking `https://your-railway-app.railway.app/api/health`:
   ```json
   { "status": "ok", "service": "Momentum", ... }
   ```

### Vercel frontend

1. Set `NEXT_PUBLIC_API_URL` to your Railway backend URL:
   ```
   NEXT_PUBLIC_API_URL=https://your-railway-app.railway.app
   ```

### Vercel preview deployments

Vercel creates unique URLs for each pull request (e.g.
`https://momentum-pr-42.vercel.app`). To allow those to call the Railway
backend, add them to `ADDITIONAL_ORIGINS` in Railway:

```
ADDITIONAL_ORIGINS=https://momentum-pr-42.vercel.app,https://momentum-pr-99.vercel.app
```

For dynamic preview URLs (where the PR number changes), you have two options:

**Option A (simpler):** use a fixed Vercel preview alias and add that to
`ADDITIONAL_ORIGINS`.

**Option B (for CI):** set `ADDITIONAL_ORIGINS` programmatically via the
Railway API each time a preview is deployed.

---

## Security notes

- Tokens are Bearer JWTs, not cookies. They survive page refreshes only if
  stored in `localStorage` or `sessionStorage`. Consider the trade-offs:
  `localStorage` is accessible to XSS; `sessionStorage` clears on tab close.
  Storing in memory (a module-level variable) is safest but loses state on
  refresh.

- The backend returns CORS headers only for origins in the allowlist. An
  attacker's website will not receive `Access-Control-Allow-Origin` and the
  browser will block their JS from reading the response.

- Presigned S3 URLs are short-lived (5 minutes) and are only issued to
  authenticated, ownership-verified requests. Treat them as single-use links.

- The backend does not set `Access-Control-Allow-Credentials: true` (not
  needed for Bearer tokens). This means cookies sent by the browser are
  ignored by CORS, which is correct.

---

## Request tracing

Every API response from the Railway backend includes:

```
X-Request-ID: <uuid>
```

Log this value in the frontend for support debugging. It correlates to
structured log entries on the Railway side.

```typescript
const response = await fetch(`${API_URL}/api/appointments`, {
  headers: { Authorization: `Bearer ${token}` },
});

const requestId = response.headers.get("X-Request-ID");
console.log("[api] request-id:", requestId);
```
