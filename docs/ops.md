# Momentum — Operations Guide (Google Cloud)

## Logging

### Format
All application logs are emitted as newline-delimited JSON to stdout/stderr:
```json
{ "ts": "2025-01-15T10:00:00.000Z", "level": "info", "tag": "auth:login", "message": "Login successful", "requestId": "uuid", "userId": "uuid" }
```

Cloud Logging captures stdout and stderr from Cloud Run automatically.
Logs are queryable in the Google Cloud Console under **Logging → Log Explorer**
using the filter: `resource.type="cloud_run_revision"`.

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

### What to monitor (Cloud Logging alerts)
Create log-based alerts in Cloud Monitoring:
- Alert on `"level":"error"` log entries
- Alert on HTTP 5xx response rates via Cloud Run metrics
- Alert on latency spikes via Cloud Run `request_latencies` metric

**Key error patterns to alert on:**
| Tag | Condition | Action |
|-----|-----------|--------|
| `ai-pipeline` | `"Pipeline failed"` | Check Perplexity/Gemini API status; appointments stuck in `pending` |
| `auth:login` | `"Login failed"` rate spike | Possible credential stuffing; rate limiter may need tightening |
| `webhook:omi` | `"Invalid webhook signature"` | OMI device misconfiguration |
| Any route | `status: 500` | Check Cloud Logging for stack trace; likely GCS or env var issue |

---

## GCS Backup and Disaster Recovery

### What is in GCS
All persistent data:
- `{env}/system/users/` — user records and email→ID index
- `{env}/patients/{userId}/` — appointments, transcripts, summaries, embeddings

### Recommended backup strategy
1. **Enable Object Versioning** on the bucket. This protects against accidental deletes and overwrites.
2. **Enable Cross-Region Replication** via GCS dual-region or multi-region bucket configuration for geographic redundancy.
3. **Enable Bucket Lock** (retention policy) if regulatory requirements mandate immutability of medical records.

**Recovery procedure:**
1. In the GCP Console → Cloud Storage → select the bucket
2. Enable "Show deleted objects" to see versioned deleted objects
3. Select the previous version and restore
4. Alternatively, use `gsutil rsync` to restore from a backup bucket

### RPO / RTO expectations
| Scenario | RPO | RTO |
|----------|-----|-----|
| Accidental single-object delete (versioning on) | Zero | < 5 min |
| Region outage (dual-region/multi-region bucket) | Last replication (seconds) | Minutes |
| Bucket accidentally deleted | Last external backup | Hours |

---

## GCS Lifecycle Rules (Cost Control)

Use GCS Object Lifecycle Management to automatically transition or delete objects.

Configure via the GCP Console (Storage → Bucket → Lifecycle) or Terraform.

### Recommended rules

**1. Transition raw transcripts to Nearline storage after 90 days:**
```json
{
  "rule": [
    {
      "action": { "type": "SetStorageClass", "storageClass": "NEARLINE" },
      "condition": {
        "age": 90,
        "matchesPrefix": ["production/patients/"],
        "matchesSuffix": ["_transcript.txt"]
      }
    }
  ]
}
```

**2. Expire stale development-prefix objects after 30 days:**
```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": {
        "age": 30,
        "matchesPrefix": ["development/"]
      }
    }
  ]
}
```

**3. Delete old non-current versions after 30 days (if versioning enabled):**
```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": {
        "numNewerVersions": 1,
        "daysSinceNoncurrentTime": 30
      }
    }
  ]
}
```

---

## Known Operational Limitations

| Item | Status | Mitigation |
|------|--------|------------|
| In-memory rate limiter reset on restart | Known | Rate limit resets are acceptable on deploy; use Cloud Memorystore (Redis) for production |
| JWT denylist (logout) reset on restart | Known | Tokens expire in 7 days; client-side discard is the primary mechanism |
| GCS index files use read-then-write | Known | Safe for single-replica Cloud Run; use Firestore for atomic writes at scale |
| Appointment index unbounded growth | Low risk | `listAppointments` loads all IDs; add pagination to the index file for patients with >1000 appointments |
| Gemini embedding index size | Low risk | Capped at 20 MB per patient; revisit for patients with very many appointments |
| Signed URLs require signBlob IAM | Known | Service account must have `iam.serviceAccountTokenCreator`; see GCP deployment docs |
| `after()` not guaranteed to complete on SIGKILL | Known | Appointments stuck in `pending` can be recovered via `POST /api/appointments/:id/summarize` |

---

## Periodic Maintenance

### Soft-delete cleanup
Run the cleanup script periodically (e.g., monthly via a Cloud Scheduler job) to remove GCS artifacts for soft-deleted appointments:

```bash
# Dry run (see what would be deleted)
npm run cleanup

# Actually delete
npm run cleanup -- --delete
```

### Embedding index review
Monitor the size of `{env}/patients/{userId}/embeddings/embedding_index.json` objects. If any approach 20 MB, consider sharding the index or increasing the `MAX_BYTE_SIZES.embeddings` limit in `src/lib/s3.ts`.
