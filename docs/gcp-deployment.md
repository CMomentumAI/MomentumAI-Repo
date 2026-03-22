# Momentum — Google Cloud Deployment Guide

**Architecture:**
- Backend runtime: **Google Cloud Run**
- Object storage: **Google Cloud Storage (GCS)**
- Secrets: **Google Secret Manager**
- Frontend: **Vercel** (separate service, unchanged)

---

## Prerequisites

```bash
# Install the gcloud CLI
# https://cloud.google.com/sdk/docs/install

# Authenticate
gcloud auth login

# Set your project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com
```

---

## 1. Create a GCS Bucket

```bash
# Create a private bucket (replace REGION with your preferred region)
gsutil mb -l REGION gs://momentum-patient-data-YOUR_PROJECT_ID

# Block public access
gsutil uniformbucketlevelaccess set on gs://momentum-patient-data-YOUR_PROJECT_ID

# Enable versioning (recommended for data safety)
gsutil versioning set on gs://momentum-patient-data-YOUR_PROJECT_ID
```

---

## 2. Create a Service Account

```bash
# Create the service account
gcloud iam service-accounts create momentum-backend \
  --display-name="Momentum API Backend"

SA_EMAIL="momentum-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com"

# Grant Storage Object Admin on the bucket
gsutil iam ch serviceAccount:${SA_EMAIL}:roles/storage.objectAdmin \
  gs://momentum-patient-data-YOUR_PROJECT_ID

# Grant signBlob permission (required for signed download URLs)
gcloud iam service-accounts add-iam-policy-binding ${SA_EMAIL} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

---

## 3. Store Secrets in Secret Manager

```bash
# Helper function
create_secret() {
  echo -n "$2" | gcloud secrets create $1 --data-file=-
}

# Generate JWT secret: openssl rand -base64 32
create_secret momentum-jwt-secret     "YOUR_JWT_SECRET_MIN_32_CHARS"
create_secret momentum-perplexity-key "pplx-..."
create_secret momentum-gemini-key     "AIza..."
create_secret momentum-elevenlabs-key "sk_..."
create_secret momentum-omi-secret     "YOUR_WEBHOOK_SECRET_MIN_32_CHARS"

# Grant the service account access to read secrets
SA_EMAIL="momentum-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 4. Build and Push the Container

```bash
# Option A: Cloud Build (recommended for CI)
gcloud builds submit \
  --tag gcr.io/YOUR_PROJECT_ID/momentum-api:latest \
  .

# Option B: Docker + Artifact Registry (local build)
gcloud auth configure-docker gcr.io

docker build -t gcr.io/YOUR_PROJECT_ID/momentum-api:latest .
docker push gcr.io/YOUR_PROJECT_ID/momentum-api:latest
```

---

## 5. Deploy to Cloud Run

### Option A: gcloud CLI (quick deploy)

```bash
gcloud run deploy momentum-api \
  --image gcr.io/YOUR_PROJECT_ID/momentum-api:latest \
  --region us-central1 \
  --service-account momentum-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars "GCS_PROJECT_ID=YOUR_PROJECT_ID,CORS_ALLOWED_ORIGINS=https://momentum.vercel.app,CORS_ALLOW_CREDENTIALS=false" \
  --set-env-vars "GCS_BUCKET_NAME=momentum-patient-data-YOUR_PROJECT_ID" \
  --update-secrets "JWT_SECRET=momentum-jwt-secret:latest" \
  --update-secrets "PERPLEXITY_API_KEY=momentum-perplexity-key:latest" \
  --update-secrets "GEMINI_API_KEY=momentum-gemini-key:latest" \
  --update-secrets "ELEVENLABS_API_KEY=momentum-elevenlabs-key:latest" \
  --update-secrets "OMI_WEBHOOK_SECRET=momentum-omi-secret:latest" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10
```

### Option B: Service YAML (recommended for production)

Edit `cloud-run-service.yaml` with your project ID and bucket name, then:

```bash
gcloud run services replace cloud-run-service.yaml \
  --region us-central1 \
  --project YOUR_PROJECT_ID
```

---

## 6. Verify Deployment

```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe momentum-api \
  --region us-central1 \
  --format "value(status.url)")

echo "Service URL: $SERVICE_URL"

# Check health endpoint
curl "$SERVICE_URL/api/health"
# Expected: { "status": "ok", "service": "Momentum", "config": { ... } }
```

---

## 7. Configure the Vercel Frontend

In the Vercel dashboard for your frontend project, set:

```
NEXT_PUBLIC_API_URL=https://momentum-api-xxxx-uc.a.run.app
```

Replace with the actual Cloud Run URL from the previous step.

---

## Local Development

For local development against GCS:

```bash
# Option A: Service account key file
gcloud iam service-accounts keys create /tmp/momentum-dev-key.json \
  --iam-account momentum-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com

export GOOGLE_APPLICATION_CREDENTIALS=/tmp/momentum-dev-key.json

# Option B: Your own user credentials (simpler, uses your gcloud access)
gcloud auth application-default login
```

Then create `.env.local`:
```
GCS_BUCKET_NAME=momentum-patient-data-YOUR_PROJECT_ID
GCS_PROJECT_ID=YOUR_PROJECT_ID
# ... other env vars
```

---

## GCS Bucket CORS Configuration (for Presigned URLs)

If the Vercel frontend fetches presigned URLs directly from the browser,
the GCS bucket needs a CORS policy:

```bash
cat > /tmp/cors.json << 'EOF'
[
  {
    "origin": ["https://momentum.vercel.app", "http://localhost:3000"],
    "method": ["GET"],
    "responseHeader": ["Content-Type", "Content-Disposition"],
    "maxAgeSeconds": 3600
  }
]
EOF

gsutil cors set /tmp/cors.json gs://momentum-patient-data-YOUR_PROJECT_ID
```

---

## CI/CD with Cloud Build

Create `cloudbuild.yaml`:

```yaml
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/momentum-api:$COMMIT_SHA', '.']

  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/momentum-api:$COMMIT_SHA']

  - name: 'gcr.io/cloud-builders/gcloud'
    args:
      - run
      - deploy
      - momentum-api
      - --image=gcr.io/$PROJECT_ID/momentum-api:$COMMIT_SHA
      - --region=us-central1
      - --quiet

images:
  - 'gcr.io/$PROJECT_ID/momentum-api:$COMMIT_SHA'
```

---

## Troubleshooting

### Signed URL errors
If `getPresignedDownloadUrl` fails with "Failed to generate signed URL":
1. Confirm the service account has `iam.serviceAccountTokenCreator` on itself
2. For local dev, ensure `GOOGLE_APPLICATION_CREDENTIALS` points to a valid key file

### GCS permission denied
If uploads/downloads fail with permission errors:
1. Confirm the service account has `roles/storage.objectAdmin` on the bucket
2. Check that the Cloud Run service is using the correct service account

### Container health check failing
1. Check Cloud Run logs: `gcloud logging read "resource.type=cloud_run_revision" --limit 50`
2. Ensure all required env vars are set (check `/api/health` response `config` object)
