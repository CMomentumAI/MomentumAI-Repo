/**
 * AWS S3 utilities for secure patient data storage.
 * All objects are stored with server-side encryption (AES-256).
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { getEnv } from "./env";

// ─── Client (lazy singleton) ─────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build an S3 key namespaced by patient for strict data isolation. */
export function buildS3Key(
  patientId: string,
  category: "transcripts" | "summaries" | "audio" | "embeddings" | "forms",
  filename: string,
): string {
  return `patients/${patientId}/${category}/${filename}`;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function uploadToS3(
  key: string,
  body: string | Buffer | Uint8Array,
  contentType = "application/json",
): Promise<string> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }),
  );
  return key;
}

// ─── Download ─────────────────────────────────────────────────────────────────

export async function downloadFromS3(key: string): Promise<string> {
  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
  );

  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteFromS3(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: getBucket(), Key: key }),
  );
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listS3Objects(prefix: string): Promise<string[]> {
  const response = await getS3Client().send(
    new ListObjectsV2Command({ Bucket: getBucket(), Prefix: prefix }),
  );
  return (response.Contents ?? []).map((obj) => obj.Key!).filter(Boolean);
}

// ─── Presigned URL (client-side download) ────────────────────────────────────

export async function getPresignedUrl(
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
}

