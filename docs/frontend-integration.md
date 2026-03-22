# Momentum Frontend Integration Guide (Same-Origin)

Momentum is now intended to run as a **single Next.js app** on Vercel:

- Frontend pages/components
- Backend route handlers under `src/app/api/**`

This means frontend code should call **same-origin** endpoints:

```ts
await fetch("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
await fetch("/api/appointments");
await fetch("/api/chat", { method: "POST", body: JSON.stringify({ question }) });
```

## Auth model

- Auth is Bearer JWT.
- Send `Authorization: Bearer <token>` for protected routes.
- Do not expose secrets client-side.

## Webhook route

OMI webhook endpoint:

- Primary: `POST /api/webhook/omi`
- Alias: `POST /api/webhooks/omi`

Both routes have identical behavior (HMAC verification + idempotent processing).

## Optional cross-origin callers

If a separate browser origin must call this API, configure:

- `CORS_ALLOWED_ORIGINS`
- `CORS_ALLOW_CREDENTIALS` (only when required)

For the primary same-origin deployment on Vercel, these are typically unnecessary.
