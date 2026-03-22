/**
 * AWS S3 storage utilities for the Momentum backend.
 *
 * WHY S3 AND NOT DISK:
 * Railway runs application containers with ephemeral local filesystems.
 * Every redeploy, crash-restart, or scale event starts from a clean image,
 * wiping any files written to disk at runtime. All persistent data — patient
 * transcripts, summaries, embeddings, audio, and user records — MUST live in
 * S3. Direct disk writes in route handlers would survive only until the next
 * container restart.
 *
 * KEY STRUCTURE:
 *   Patient data:  {env}/patients/{patientId}/{category}/{filename}
 *   System data:   {env}/system/{subpath}
 *
 * The {env} prefix isolates development and production data within a shared
 * bucket, preventing dev test data from polluting the production namespace.
 *
 * All objects are stored with AES-256 server-side encryption.
 * All uploads include S3 user metadata (x-amz-meta-*) recording ownership,
 * category, and upload timestamp for audit purposes.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { getEnv } from "./env";

// ─── Typed error ─────────────────────────────────────────────────────────────

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
 * production data within the same S3 bucket.
 */
function envPrefix(): string {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

// ─── S3 client (lazy singleton) ──────────────────────────────────────────────

let _s3: S3Client | null = null;

function getS3Client(): S3Client {
  if (!_s3) {
    const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = getEnv();
    _s3 = new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

function getBucket(): string {
  return getEnv().AWS_S3_BUCKET_NAME;
}

// ─── Key component validation ─────────────────────────────────────────────────

/**
 * Validate an ID component (UUID, user ID, etc.).
 * Permits alphanumeric characters and hyphens only, which covers all UUIDs
 * and prevents path traversal or injection into S3 key paths.
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
 * Build a scoped, validated S3 key for patient-owned data.
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
 * Build a system-level S3 key for non-patient data (user records, indexes).
 *
 * Structure: {env}/system/{subpath}
 *
 * The subpath may contain forward slashes (treated as S3 "directory"
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

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  );
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export interface UploadOptions {
  /** Storage category — enables content-type and byte-size validation. */
  category?: S3Category;
  /** Owning patient ID — stored as S3 object metadata for audit purposes. */
  patientId?: string;
}

/**
 * Upload an object to S3 with AES-256 server-side encryption.
 *
 * When `options.category` is provided:
 *   - content-type is validated against the category's allowlist
 *   - byte size is validated against the category's limit
 *
 * S3 user metadata records patientId, category, and upload timestamp so that
 * object ownership can be confirmed via a HEAD request without downloading the
 * full body.
 *
 * Returns the S3 key on success.
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

  const metadata: Record<string, string> = {
    "uploaded-at": new Date().toISOString(),
  };
  if (patientId) metadata["patient-id"] = patientId;
  if (category) metadata["category"] = category;

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getBucket(),
        Key: key,
        Body: bodyBuffer,
        ContentType: contentType,
        ContentLength: byteSize,
        ServerSideEncryption: "AES256",
        Metadata: metadata,
      }),
    );
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
 * Download an S3 object and decode it as a UTF-8 string.
 * Throws S3StorageError(NOT_FOUND) when the object does not exist.
 * Throws S3StorageError(DOWNLOAD_FAILED) for all other S3 errors.
 */
export async function downloadFromS3(key: string): Promise<string> {
  let response;
  try {
    response = await getS3Client().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    );
  } catch (err) {
    throw new S3StorageError(
      `Failed to download "${key}": ${err instanceof Error ? err.message : String(err)}`,
      isNotFound(err) ? "NOT_FOUND" : "DOWNLOAD_FAILED",
      key,
    );
  }

  if (!response.Body) {
    throw new S3StorageError(
      `S3 returned an empty body for "${key}"`,
      "DOWNLOAD_FAILED",
      key,
    );
  }

  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Download an S3 object and return its raw bytes.
 * Use this for binary content such as MP3 audio files.
 * Throws S3StorageError(NOT_FOUND) when the object does not exist.
 */
export async function downloadFromS3Binary(key: string): Promise<Buffer> {
  let response;
  try {
    response = await getS3Client().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    );
  } catch (err) {
    throw new S3StorageError(
      `Failed to download binary "${key}": ${err instanceof Error ? err.message : String(err)}`,
      isNotFound(err) ? "NOT_FOUND" : "DOWNLOAD_FAILED",
      key,
    );
  }

  if (!response.Body) {
    throw new S3StorageError(
      `S3 returned an empty body for "${key}"`,
      "DOWNLOAD_FAILED",
      key,
    );
  }

  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ─── HEAD (metadata without body) ────────────────────────────────────────────

export interface S3ObjectMeta {
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
  /** S3 user metadata (x-amz-meta-* headers, returned without the prefix). */
  metadata?: Record<string, string>;
}

/**
 * Fetch S3 object metadata without downloading the body.
 * Returns null when the object does not exist (safe to use as an existence
 * check before issuing a presigned URL).
 * Throws S3StorageError(HEAD_FAILED) for non-404 errors.
 */
export async function getObjectMetadata(
  key: string,
): Promise<S3ObjectMeta | null> {
  try {
    const response = await getS3Client().send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: key }),
    );
    return {
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      lastModified: response.LastModified,
      metadata: response.Metadata,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new S3StorageError(
      `Failed to HEAD "${key}": ${err instanceof Error ? err.message : String(err)}`,
      "HEAD_FAILED",
      key,
    );
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete an S3 object.
 * S3 DeleteObject is idempotent — deleting a non-existent key succeeds silently.
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
    );
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
 * List all object keys under a given prefix.
 * Returns an empty array when no objects are found (not an error).
 */
export async function listS3Objects(prefix: string): Promise<string[]> {
  try {
    const response = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: getBucket(), Prefix: prefix }),
    );
    return (response.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((k): k is string => typeof k === "string");
  } catch (err) {
    throw new S3StorageError(
      `Failed to list objects under "${prefix}": ${err instanceof Error ? err.message : String(err)}`,
      "LIST_FAILED",
      prefix,
    );
  }
}

// ─── Presigned download URL ───────────────────────────────────────────────────

const MIN_PRESIGNED_EXPIRY_S = 60;        // 1 minute
const MAX_PRESIGNED_EXPIRY_S = 15 * 60;  // 15 minutes

/**
 * Generate a short-lived presigned URL that allows the holder to download a
 * specific S3 object without AWS credentials.
 *
 * OWNERSHIP NOTE: This function does NOT verify that the requested key belongs
 * to the authenticated user. Callers MUST confirm ownership before calling
 * this function — e.g. by verifying the key's patientId segment matches the
 * authenticated user's ID, or by calling getObjectMetadata() and checking the
 * x-amz-meta-patient-id header.
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
    const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
    return getSignedUrl(getS3Client(), command, { expiresIn: expiry });
  } catch (err) {
    throw new S3StorageError(
      `Failed to generate presigned URL for "${key}": ${err instanceof Error ? err.message : String(err)}`,
      "HEAD_FAILED",
      key,
    );
  }
}

