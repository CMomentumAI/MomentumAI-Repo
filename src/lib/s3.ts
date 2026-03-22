/**
 * Google Cloud Storage utilities for the Momentum backend.
 *
 * WHY CLOUD STORAGE AND NOT DISK:
 * Cloud Run containers have ephemeral local filesystems. Every redeploy,
 * crash-restart, or scale event starts from a clean image, wiping any files
 * written to disk at runtime. All persistent data — patient transcripts,
 * summaries, embeddings, audio, and user records — MUST live in GCS.
 * Direct disk writes in route handlers would not survive a container restart.
 *
 * KEY STRUCTURE:
 *   Patient data:  {env}/patients/{patientId}/{category}/{filename}
 *   System data:   {env}/system/{subpath}
 *
 * The {env} prefix isolates development and production data within a shared
 * bucket, preventing dev test data from polluting the production namespace.
 *
 * ENCRYPTION:
 * GCS encrypts all data at rest by default using AES-256 (Google-managed
 * encryption keys). No explicit encryption flag is required on upload.
 * Customer-managed encryption keys (CMEK) can be configured at the bucket
 * level in the GCP console if required for compliance.
 *
 * CREDENTIALS:
 *   Cloud Run:    Application Default Credentials (ADC) are used automatically.
 *                 The Cloud Run service account must have Storage Object Admin
 *                 and iam.serviceAccounts.signBlob (for signed URLs).
 *   Local dev:    Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
 *                 or run `gcloud auth application-default login`.
 *
 * The exported function names, signatures, and error types are intentionally
 * kept stable so callers (routes, services, scripts, tests) need no changes.
 */

import { Storage, type File } from "@google-cloud/storage";
import { getEnv } from "./env";

// ─── Typed error ─────────────────────────────────────────────────────────────
// Error codes are kept identical to the previous S3 implementation so that
// all existing error-handling code continues to work without modification.

export type S3ErrorCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "INVALID_KEY"
  | "SIZE_EXCEEDED"
  | "INVALID_CONTENT_TYPE"
  | "UPLOAD_FAILED"
  | "DOWNLOAD_FAILED"
  | "DELETE_FAILED"
  | "LIST_FAILED"
  | "HEAD_FAILED";

export class S3StorageError extends Error {
  constructor(
    message: string,
    public readonly code: S3ErrorCode,
    public readonly key?: string,
  ) {
    super(message);
    this.name = "S3StorageError";
  }
}

// ─── File categories ─────────────────────────────────────────────────────────

export type S3Category =
  | "appointments"
  | "transcripts"
  | "summaries"
  | "audio"
  | "embeddings"
  | "forms";

/** Permitted content-types per storage category. */
const ALLOWED_CONTENT_TYPES: Record<S3Category, readonly string[]> = {
  appointments: ["application/json"],
  transcripts: ["text/plain", "application/json"],
  summaries: ["application/json"],
  audio: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"],
  embeddings: ["application/json"],
  forms: ["application/json"],
};

/** Maximum upload sizes in bytes per category. */
export const MAX_BYTE_SIZES: Record<S3Category, number> = {
  appointments: 256 * 1024,      // 256 KB — appointment JSON metadata
  transcripts: 1024 * 1024,      // 1 MB — raw transcript text
  summaries: 256 * 1024,         // 256 KB — structured summary JSON
  audio: 50 * 1024 * 1024,       // 50 MB — MP3 audio
  embeddings: 20 * 1024 * 1024,  // 20 MB — per-patient embedding index
  forms: 128 * 1024,             // 128 KB — generated form JSON
};

// ─── Environment prefix ───────────────────────────────────────────────────────

/**
 * Returns a namespace prefix based on NODE_ENV to isolate development and
 * production data within the same GCS bucket.
 */
function envPrefix(): string {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

// ─── GCS client (lazy singleton) ──────────────────────────────────────────────

let _gcs: Storage | null = null;

function getGcsClient(): Storage {
  if (!_gcs) {
    const { GCS_PROJECT_ID } = getEnv();
    // Credentials are resolved automatically via Application Default Credentials
    // (ADC). On Cloud Run the service account is used. Locally, set
    // GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login`.
    _gcs = new Storage({ projectId: GCS_PROJECT_ID });
  }
  return _gcs;
}

function getGcsBucket() {
  return getGcsClient().bucket(getEnv().GCS_BUCKET_NAME);
}

/** Convenience helper to get a File reference without making a network call. */
function getFile(key: string): File {
  return getGcsBucket().file(key);
}

// ─── Key component validation ─────────────────────────────────────────────────

/**
 * Validate an ID component (UUID, user ID, etc.).
 * Permits alphanumeric characters and hyphens only, which covers all UUIDs
 * and prevents path traversal or injection into GCS object names.
 */
function validateIdComponent(value: string, field: string): void {
  if (!value || typeof value !== "string") {
    throw new S3StorageError(
      `${field} must be a non-empty string`,
      "INVALID_KEY",
    );
  }
  if (!/^[a-zA-Z0-9\-]+$/.test(value)) {
    throw new S3StorageError(
      `${field} contains characters outside [a-zA-Z0-9-]; value rejected to prevent key injection`,
      "INVALID_KEY",
    );
  }
}

/**
 * Validate a filename component.
 * Rejects double-dots, path separators, and null bytes — the most common
 * path traversal vectors — while permitting letters, digits, dots, underscores,
 * and hyphens which are sufficient for all generated filenames.
 */
function validateFilenameComponent(value: string, field: string): void {
  if (!value || typeof value !== "string") {
    throw new S3StorageError(
      `${field} must be a non-empty string`,
      "INVALID_KEY",
    );
  }
  if (
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new S3StorageError(
      `${field} contains path traversal characters (..  / \\ \\0)`,
      "INVALID_KEY",
    );
  }
  if (!/^[a-zA-Z0-9_.\-]+$/.test(value)) {
    throw new S3StorageError(
      `${field} contains characters outside [a-zA-Z0-9_.-]`,
      "INVALID_KEY",
    );
  }
}

// ─── Key builders ─────────────────────────────────────────────────────────────

/**
 * Build a scoped, validated GCS object name for patient-owned data.
 *
 * Structure: {env}/patients/{patientId}/{category}/{filename}
 *
 * Both patientId and filename are validated before use to prevent
 * path traversal and cross-patient key construction.
 */
export function buildS3Key(
  patientId: string,
  category: S3Category,
  filename: string,
): string {
  validateIdComponent(patientId, "patientId");
  validateFilenameComponent(filename, "filename");
  return `${envPrefix()}/patients/${patientId}/${category}/${filename}`;
}

/**
 * Build a system-level GCS object name for non-patient data (user records, indexes).
 *
 * Structure: {env}/system/{subpath}
 *
 * The subpath may contain forward slashes (treated as GCS "directory"
 * separators) but must not contain path traversal sequences.
 */
export function buildSystemKey(subpath: string): string {
  if (
    !subpath ||
    subpath.includes("..") ||
    subpath.startsWith("/") ||
    subpath.includes("\0")
  ) {
    throw new S3StorageError(
      "System key subpath contains invalid characters",
      "INVALID_KEY",
      subpath,
    );
  }
  return `${envPrefix()}/system/${subpath}`;
}

// ─── Content-type and size guards ─────────────────────────────────────────────

export function validateContentType(
  category: S3Category,
  contentType: string,
): void {
  const allowed = ALLOWED_CONTENT_TYPES[category];
  if (!allowed.includes(contentType)) {
    throw new S3StorageError(
      `Content-type "${contentType}" is not permitted for category "${category}". ` +
        `Allowed: ${allowed.join(", ")}`,
      "INVALID_CONTENT_TYPE",
    );
  }
}

export function validateByteSize(
  category: S3Category,
  byteSize: number,
): void {
  const limit = MAX_BYTE_SIZES[category];
  if (byteSize > limit) {
    throw new S3StorageError(
      `Upload of ${byteSize} bytes exceeds the ${limit}-byte limit for category "${category}"`,
      "SIZE_EXCEEDED",
    );
  }
}

// ─── Error classification helper ──────────────────────────────────────────────

/** GCS returns HTTP 404 as a numeric error code when objects don't exist. */
function isNotFound(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return (
    e.code === 404 ||
    e.code === "404" ||
    (typeof e.message === "string" && e.message.includes("No such object"))
  );
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export interface UploadOptions {
  /** Storage category — enables content-type and byte-size validation. */
  category?: S3Category;
  /** Owning patient ID — stored as GCS object metadata for audit purposes. */
  patientId?: string;
}

/**
 * Upload an object to GCS.
 *
 * GCS encrypts all data at rest with AES-256 by default — no explicit
 * encryption parameter is required.
 *
 * When `options.category` is provided:
 *   - content-type is validated against the category's allowlist
 *   - byte size is validated against the category's limit
 *
 * Custom metadata records patientId, category, and upload timestamp so that
 * object ownership can be confirmed via a metadata request without downloading
 * the full body.
 *
 * Returns the GCS object name (key) on success.
 */
export async function uploadToS3(
  key: string,
  body: string | Buffer | Uint8Array,
  contentType = "application/json",
  options: UploadOptions = {},
): Promise<string> {
  const { category, patientId } = options;

  const bodyBuffer =
    typeof body === "string" ? Buffer.from(body, "utf-8") : Buffer.from(body);
  const byteSize = bodyBuffer.byteLength;

  if (category) {
    validateContentType(category, contentType);
    validateByteSize(category, byteSize);
  }

  const customMetadata: Record<string, string> = {
    "uploaded-at": new Date().toISOString(),
  };
  if (patientId) customMetadata["patient-id"] = patientId;
  if (category) customMetadata["category"] = category;

  try {
    await getFile(key).save(bodyBuffer, {
      contentType,
      metadata: { metadata: customMetadata },
    });
  } catch (err) {
    throw new S3StorageError(
      `Failed to upload "${key}": ${err instanceof Error ? err.message : String(err)}`,
      "UPLOAD_FAILED",
      key,
    );
  }

  return key;
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Download a GCS object and decode it as a UTF-8 string.
 * Throws S3StorageError(NOT_FOUND) when the object does not exist.
 * Throws S3StorageError(DOWNLOAD_FAILED) for all other GCS errors.
 */
export async function downloadFromS3(key: string): Promise<string> {
  try {
    const [contents] = await getFile(key).download();
    return contents.toString("utf-8");
  } catch (err) {
    throw new S3StorageError(
      `Failed to download "${key}": ${err instanceof Error ? err.message : String(err)}`,
      isNotFound(err) ? "NOT_FOUND" : "DOWNLOAD_FAILED",
      key,
    );
  }
}

/**
 * Download a GCS object and return its raw bytes.
 * Use this for binary content such as MP3 audio files.
 * Throws S3StorageError(NOT_FOUND) when the object does not exist.
 */
export async function downloadFromS3Binary(key: string): Promise<Buffer> {
  try {
    const [contents] = await getFile(key).download();
    return contents;
  } catch (err) {
    throw new S3StorageError(
      `Failed to download binary "${key}": ${err instanceof Error ? err.message : String(err)}`,
      isNotFound(err) ? "NOT_FOUND" : "DOWNLOAD_FAILED",
      key,
    );
  }
}

// ─── HEAD (metadata without body) ────────────────────────────────────────────

export interface S3ObjectMeta {
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
  /** GCS custom metadata fields. */
  metadata?: Record<string, string>;
}

/**
 * Fetch GCS object metadata without downloading the body.
 * Returns null when the object does not exist (safe to use as an existence
 * check before issuing a signed URL).
 * Throws S3StorageError(HEAD_FAILED) for non-404 errors.
 */
export async function getObjectMetadata(
  key: string,
): Promise<S3ObjectMeta | null> {
  try {
    const [meta] = await getFile(key).getMetadata();
    return {
      contentType: meta.contentType as string | undefined,
      contentLength:
        meta.size !== undefined ? Number(meta.size) : undefined,
      lastModified:
        meta.updated ? new Date(meta.updated as string) : undefined,
      metadata: meta.metadata as Record<string, string> | undefined,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new S3StorageError(
      `Failed to get metadata for "${key}": ${err instanceof Error ? err.message : String(err)}`,
      "HEAD_FAILED",
      key,
    );
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a GCS object.
 * GCS delete is idempotent — deleting a non-existent object succeeds silently.
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await getFile(key).delete({ ignoreNotFound: true });
  } catch (err) {
    throw new S3StorageError(
      `Failed to delete "${key}": ${err instanceof Error ? err.message : String(err)}`,
      "DELETE_FAILED",
      key,
    );
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * List all object names under a given prefix.
 * Returns an empty array when no objects are found (not an error).
 */
export async function listS3Objects(prefix: string): Promise<string[]> {
  try {
    const [files] = await getGcsBucket().getFiles({ prefix });
    return files.map((f) => f.name).filter(Boolean);
  } catch (err) {
    throw new S3StorageError(
      `Failed to list objects under "${prefix}": ${err instanceof Error ? err.message : String(err)}`,
      "LIST_FAILED",
      prefix,
    );
  }
}

// ─── Presigned download URL ───────────────────────────────────────────────────

const MIN_PRESIGNED_EXPIRY_S = 60;       // 1 minute
const MAX_PRESIGNED_EXPIRY_S = 15 * 60; // 15 minutes

/**
 * Generate a short-lived signed URL that allows the holder to download a
 * specific GCS object without Google Cloud credentials.
 *
 * REQUIREMENTS FOR SIGNED URLS:
 *   Cloud Run: the service account must have the
 *     iam.serviceAccountTokenCreator role (to sign URLs via IAM).
 *   Local dev:  set GOOGLE_APPLICATION_CREDENTIALS to a service account
 *     key JSON file with the roles/storage.objectViewer permission.
 *
 * OWNERSHIP NOTE: This function does NOT verify that the requested key belongs
 * to the authenticated user. Callers MUST confirm ownership before calling
 * this function — e.g. by verifying the key's patientId segment matches the
 * authenticated user's ID.
 *
 * Expiry is clamped to [1 min, 15 min] regardless of what the caller passes,
 * limiting the replay window for any leaked URL.
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  const expiry = Math.min(
    Math.max(expiresInSeconds, MIN_PRESIGNED_EXPIRY_S),
    MAX_PRESIGNED_EXPIRY_S,
  );

  try {
    const [url] = await getFile(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiry * 1000,
    });
    return url;
  } catch (err) {
    throw new S3StorageError(
      `Failed to generate signed URL for "${key}": ${err instanceof Error ? err.message : String(err)}`,
      "HEAD_FAILED",
      key,
    );
  }
}
