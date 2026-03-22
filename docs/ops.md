# Momentum — Operations Guide

## Logging

### Format
All application logs are emitted as newline-delimited JSON to stdout/stderr:
```json
{ "ts": "2025-01-15T10:00:00.000Z", "level": "info", "tag": "auth:login", "message": "Login successful", "requestId": "uuid", "userId": "uuid" }
```

Railway's log collector captures stdout and stderr automatically and makes them queryable in the Railway dashboard under **Deployments → Logs**.

### Log levels
| Level | Stream | When |
|-------|--------|------|
| `debug` | stdout | Verbose tracing (currently unused in production) |
| `info`  | stdout | Normal operation events |
| `warn`  | stderr | Unexpected but handled conditions (rate limits, invalid signatures, etc.) |
| `error` | stderr | Failures requiring attention |

### PHI redaction
The logger auto-redacts values for keys: `password`, `passwordhash`, `token`, `accesstoken`, `refreshtoken`, `authorization`, `secret`, `apikey`, `api_key`, `transcript`, `rawtranscript`, `signedurl`, `presignedurl`. Stack traces are omitted in production.

Never log raw transcript text, patient names, or medical data explicitly — structured fields (`appointmentId`, `userId`, byte counts) are safe.

### What to monitor (Railway alerts)
Railway does not provide native log-based alerting. Recommended options:
- Export logs to **Datadog**, **Papertrail**, or **Logtail** via Railway's log drain integration
- Alert on `"level":"error"` entries in log drain
- Alert on 5xx response rates via Railway's built-in metrics

**Key error patterns to alert on:**
| Tag | Condition | Action |
|-----|-----------|--------|
| `ai-pipeline` | `"Pipeline failed"` | Check Perplexity/Gemini API status; appointments stuck in `pending` |
| `auth:login` | `"Login failed"` rate spike | Possible credential stuffing; rate limiter may need tightening |
| `webhook:omi` | `"Invalid webhook signature"` | OMI device misconfiguration |
| Any route | `status: 500` | Check Railway logs for stack trace; likely S3 or env var issue |

---

## S3 Backup and Disaster Recovery

### What is in S3
All persistent data:
- `{env}/system/users/` — user records and email→ID index
- `{env}/patients/{userId}/` — appointments, transcripts, summaries, embeddings

### Recommended backup strategy
1. **Enable S3 Versioning** on the bucket. This protects against accidental deletes and overwrites. Versioning is free to enable; you pay only for stored versions.
2. **Enable S3 Cross-Region Replication (CRR)** to a second AWS region for geographic redundancy. Set the destination bucket's storage class to `S3 Glacier Instant Retrieval` to minimize cost.
3. **Enable S3 Object Lock** (WORM) if regulatory requirements mandate immutability of medical records.

**Recovery procedure:**
1. In the AWS console, navigate to the S3 bucket
2. Use **"List versions"** to find the version before corruption/deletion
3. Copy or restore the desired version
4. Alternatively, use `aws s3 sync` to restore from the CRR bucket

### RPO / RTO expectations
| Scenario | RPO | RTO |
|----------|-----|-----|
| Accidental single-object delete (versioning on) | Zero | < 5 min |
| Region outage (CRR enabled) | Last replication (seconds) | Minutes |
| Bucket accidentally deleted | Last external backup | Hours |

---

## S3 Lifecycle Rules (Cost Control)

Use S3 Lifecycle policies to automatically transition or expire objects and control storage costs.

### Recommended rules

**1. Transition raw transcripts to cheaper storage after 90 days:**
```json
{
  "ID": "TranscriptArchive",
  "Filter": { "Prefix": "production/patients/" },
  "Status": "Enabled",
  "Transitions": [
    { "Days": 90, "StorageClass": "STANDARD_IA" },
    { "Days": 365, "StorageClass": "GLACIER_IR" }
  ]
}
```

**2. Expire stale development-prefix objects after 30 days:**
```json
{
  "ID": "DevCleanup",
  "Filter": { "Prefix": "development/" },
  "Status": "Enabled",
  "Expiration": { "Days": 30 }
}
```

**3. Delete old object versions after 30 days (if versioning enabled):**
```json
{
  "ID": "OldVersionCleanup",
  "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
}
```

These can be applied via the AWS console (Bucket → Management → Lifecycle rules) or via `aws s3api put-bucket-lifecycle-configuration`.

---

## Known Operational Limitations

| Item | Status | Mitigation |
|------|--------|------------|
| In-memory rate limiter reset on restart | Known | Rate limit resets are acceptable on deploy; use Redis for production |
| JWT denylist (logout) reset on restart | Known | Tokens expire in 7 days; client-side discard is the primary mechanism |
| S3 index files use read-then-write | Known | Safe for single-replica Railway; use DynamoDB for atomic writes at scale |
| Appointment index unbounded growth | Low risk | `listAppointments` loads all IDs; add pagination to the index file for patients with >1000 appointments |
| Gemini embedding index size | Low risk | Capped at 20 MB per patient; revisit for patients with very many appointments |
| `after()` not guaranteed to complete on SIGKILL | Known | Appointments stuck in `pending` can be recovered via `POST /api/appointments/:id/summarize` |

---

## Periodic Maintenance

### Soft-delete cleanup
Run the cleanup script periodically (e.g., monthly via a Railway cron job) to remove S3 artifacts for soft-deleted appointments:

```bash
# Dry run (see what would be deleted)
npm run cleanup

# Actually delete
npm run cleanup -- --delete
```

### Embedding index review
Monitor the size of `{env}/patients/{userId}/embeddings/embedding_index.json` files. If any approach 20 MB, consider sharding the index or increasing the `MAX_BYTE_SIZES.embeddings` limit in `src/lib/s3.ts`.
