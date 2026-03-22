/**
 * Patient user store backed by AWS S3.
 *
 * WHY S3: Railway container filesystems are ephemeral — files written to disk
 * are lost on every redeploy or restart. User records (including password
 * hashes) MUST live in S3, not on disk.
 *
 * STORAGE LAYOUT:
 *   {env}/system/users/{userId}.json   — individual user record
 *   {env}/system/users/index.json      — email → userId lookup map
 *
 * The S3-backed approach provides encrypted-at-rest storage (AES-256) without
 * requiring an additional database dependency during the hackathon phase.
 * For production, replace with PostgreSQL or another relational store.
 *
 * CONCURRENCY: The email-index is updated with a read-then-write which is
 * subject to a race condition under concurrent registration requests. At
 * hackathon/single-instance Railway scale this is unlikely to matter, but a
 * production deployment should use atomic conditional writes.
 */

import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import { buildSystemKey, uploadToS3, downloadFromS3, S3StorageError } from "./s3";
import type { Patient } from "@/types";

// 13 rounds is the OWASP recommendation for healthcare data.
// In the test environment we use 1 round so setup runs in milliseconds.
const SALT_ROUNDS = process.env.NODE_ENV === "test" ? 1 : 13;

interface StoredUser extends Patient {
  passwordHash: string;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function userKey(userId: string): string {
  // userId comes from uuidv4() on creation, or from a JWT sub claim which was
  // set from a uuidv4(). Both are safe to embed in a path without further
  // validation, but we go through buildSystemKey to get the env prefix.
  return buildSystemKey(`users/${userId}.json`);
}

function userIndexKey(): string {
  return buildSystemKey("users/index.json");
}

// ─── Index helpers ────────────────────────────────────────────────────────────

async function loadIndex(): Promise<Record<string, string>> {
  try {
    const raw = await downloadFromS3(userIndexKey());
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string>;
  } catch (err) {
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") return {};
    throw err;
  }
}

async function saveIndex(index: Record<string, string>): Promise<void> {
  await uploadToS3(userIndexKey(), JSON.stringify(index), "application/json");
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createUser(
  email: string,
  password: string,
  name: string,
): Promise<Patient> {
  const index = await loadIndex();
  const normalizedEmail = email.toLowerCase();

  if (index[normalizedEmail]) {
    throw new Error("A user with this email already exists.");
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user: StoredUser = {
    id,
    email: normalizedEmail,
    name,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  };

  // Write the user record first. If this fails, the index is not updated so
  // there is no dangling index entry pointing at a missing record.
  await uploadToS3(userKey(id), JSON.stringify(user), "application/json");

  // Update the email→id index after the record is safely persisted.
  index[normalizedEmail] = id;
  await saveIndex(index);

  const { passwordHash: _pw, ...publicUser } = user;
  return publicUser;
}

export async function getUserByEmail(
  email: string,
): Promise<StoredUser | null> {
  const index = await loadIndex();
  const userId = index[email.toLowerCase()];
  if (!userId) return null;

  try {
    const raw = await downloadFromS3(userKey(userId));
    return JSON.parse(raw) as StoredUser;
  } catch (err) {
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}

export async function getUserById(id: string): Promise<Patient | null> {
  try {
    const raw = await downloadFromS3(userKey(id));
    const user = JSON.parse(raw) as StoredUser;
    const { passwordHash: _pw, ...publicUser } = user;
    return publicUser;
  } catch (err) {
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export async function updateUserProfile(
  id: string,
  updates: Partial<Pick<Patient, "name" | "dateOfBirth">>,
): Promise<Patient | null> {
  try {
    const raw = await downloadFromS3(userKey(id));
    const user = JSON.parse(raw) as StoredUser;
    const updated: StoredUser = {
      ...user,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await uploadToS3(userKey(id), JSON.stringify(updated), "application/json");
    const { passwordHash: _pw, ...publicUser } = updated;
    return publicUser;
  } catch (err) {
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}
