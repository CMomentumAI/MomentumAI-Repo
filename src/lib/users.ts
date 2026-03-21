/**
 * Lightweight in-memory patient store backed by S3.
 *
 * For a production deployment swap this with a proper database (PostgreSQL, etc.).
 * The S3-backed approach provides HIPAA-aligned encrypted storage without an
 * additional database dependency during the hackathon phase.
 */

import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import { uploadToS3, downloadFromS3 } from "./s3";
import type { Patient } from "@/types";

const USERS_PREFIX = "system/users";
const SALT_ROUNDS = 13; // OWASP recommendation for healthcare data

interface StoredUser extends Patient {
  passwordHash: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userKey(userId: string): string {
  return `${USERS_PREFIX}/${userId}.json`;
}

function userIndexKey(): string {
  return `${USERS_PREFIX}/index.json`;
}

// ─── Index ───────────────────────────────────────────────────────────────────

async function loadIndex(): Promise<Record<string, string>> {
  try {
    const raw = await downloadFromS3(userIndexKey());
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveIndex(index: Record<string, string>): Promise<void> {
  await uploadToS3(userIndexKey(), JSON.stringify(index));
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createUser(
  email: string,
  password: string,
  name: string,
): Promise<Patient> {
  const index = await loadIndex();

  if (index[email.toLowerCase()]) {
    throw new Error("A user with this email already exists.");
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user: StoredUser = {
    id,
    email: email.toLowerCase(),
    name,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  };

  await uploadToS3(userKey(id), JSON.stringify(user));

  index[email.toLowerCase()] = id;
  await saveIndex(index);

  // Return public fields only
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
  } catch {
    return null;
  }
}

export async function getUserById(id: string): Promise<Patient | null> {
  try {
    const raw = await downloadFromS3(userKey(id));
    const user = JSON.parse(raw) as StoredUser;
    const { passwordHash: _pw, ...publicUser } = user;
    return publicUser;
  } catch {
    return null;
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
    await uploadToS3(userKey(id), JSON.stringify(updated));
    const { passwordHash: _pw, ...publicUser } = updated;
    return publicUser;
  } catch {
    return null;
  }
}
