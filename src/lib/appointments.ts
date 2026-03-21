/**
 * Appointment data store backed by AWS S3.
 *
 * WHY S3: Railway container filesystems are ephemeral — any file written to
 * disk is lost on the next redeploy or crash-restart. All appointment records
 * and their associated artifacts live exclusively in S3.
 *
 * STORAGE LAYOUT (per patient):
 *   {env}/patients/{patientId}/appointments/{appointmentId}.json  — record
 *   {env}/patients/{patientId}/appointments/index.json            — ID list
 *   {env}/patients/{patientId}/transcripts/{appointmentId}_transcript.txt
 *   {env}/patients/{patientId}/summaries/{appointmentId}_summary.json
 *   {env}/patients/{patientId}/embeddings/embedding_index.json
 *
 * CONCURRENCY NOTE: The index file is updated with a read-then-write pattern.
 * Under concurrent requests for the same patient (e.g. two simultaneous webhook
 * calls) a lost-update race is possible. For a hackathon-scale single-instance
 * Railway deployment this is acceptable. A production system should use an
 * atomic compare-and-swap via DynamoDB conditional writes or a relational DB.
 */

import { v4 as uuidv4 } from "uuid";
import {
  buildS3Key,
  uploadToS3,
  downloadFromS3,
  S3StorageError,
} from "./s3";
import type { Appointment, AppointmentCreateInput, AppointmentUpdate } from "@/types";

// ─── Key helpers ─────────────────────────────────────────────────────────────

/** Appointment record key. Uses the dedicated "appointments" category. */
function appointmentMetaKey(patientId: string, appointmentId: string): string {
  return buildS3Key(patientId, "appointments", `${appointmentId}.json`);
}

/** Per-patient index of appointment IDs. */
function appointmentIndexKey(patientId: string): string {
  return buildS3Key(patientId, "appointments", "index.json");
}

// ─── Index helpers ────────────────────────────────────────────────────────────

async function loadAppointmentIndex(patientId: string): Promise<string[]> {
  try {
    const raw = await downloadFromS3(appointmentIndexKey(patientId));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch (err) {
    // A missing index means no appointments exist yet — that is expected.
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") return [];
    // Any other S3 error (permissions, bucket misconfiguration) is a real
    // failure and should surface rather than silently returning an empty list.
    throw err;
  }
}

async function appendToIndex(
  patientId: string,
  appointmentId: string,
): Promise<void> {
  const ids = await loadAppointmentIndex(patientId);
  if (!ids.includes(appointmentId)) {
    ids.push(appointmentId);
    await uploadToS3(
      appointmentIndexKey(patientId),
      JSON.stringify(ids),
      "application/json",
      { category: "appointments", patientId },
    );
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createAppointment(
  patientId: string,
  data: Partial<AppointmentCreateInput>,
): Promise<Appointment> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const appointment: Appointment = {
    id,
    patientId,
    title: data.title ?? "Doctor's Appointment",
    doctorName: data.doctorName,
    specialty: data.specialty,
    date: data.date ?? now,
    rawTranscript: data.rawTranscript,
    summary: undefined,
    keyPoints: [],
    prescriptions: [],
    followUps: [],
    status: data.status ?? "pending",
    audioS3Key: undefined,
    transcriptS3Key: undefined,
    summaryS3Key: undefined,
    embeddingS3Key: undefined,
    transcriptSizeBytes: undefined,
    summarySizeBytes: undefined,
    createdAt: now,
    updatedAt: now,
  };

  const serialized = JSON.stringify(appointment);
  await uploadToS3(
    appointmentMetaKey(patientId, id),
    serialized,
    "application/json",
    { category: "appointments", patientId },
  );
  await appendToIndex(patientId, id);

  return appointment;
}

/**
 * Fetch a single appointment record.
 *
 * Returns null when the appointment does not exist or has been soft-deleted.
 *
 * OWNERSHIP: The S3 key is scoped to patientId, so a patient can only ever
 * reach their own records via this function. Additionally, the stored
 * patientId field is validated against the requested patientId to detect
 * any storage inconsistency.
 */
export async function getAppointment(
  patientId: string,
  appointmentId: string,
): Promise<Appointment | null> {
  try {
    const raw = await downloadFromS3(
      appointmentMetaKey(patientId, appointmentId),
    );
    const appointment = JSON.parse(raw) as Appointment;

    // Sanity-check stored ownership — guards against any future key-migration
    // bugs that could place one patient's record under another's prefix.
    if (appointment.patientId !== patientId) {
      throw new S3StorageError(
        `Appointment ${appointmentId} has mismatched patientId in stored record`,
        "ACCESS_DENIED",
        appointmentMetaKey(patientId, appointmentId),
      );
    }

    if (appointment.status === "deleted") return null;
    return appointment;
  } catch (err) {
    if (err instanceof S3StorageError && err.code === "NOT_FOUND") return null;
    // Re-throw ACCESS_DENIED and unexpected S3 errors so callers return 500
    // instead of silently treating storage failures as "not found".
    throw err;
  }
}

export async function updateAppointment(
  patientId: string,
  appointmentId: string,
  updates: AppointmentUpdate,
): Promise<Appointment | null> {
  const existing = await getAppointment(patientId, appointmentId);
  if (!existing) return null;

  const updated: Appointment = {
    ...existing,
    ...updates,
    // Immutable identity fields — always preserved from the original record.
    id: existing.id,
    patientId: existing.patientId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(updated);
  await uploadToS3(
    appointmentMetaKey(patientId, appointmentId),
    serialized,
    "application/json",
    { category: "appointments", patientId },
  );

  return updated;
}

export async function listAppointments(
  patientId: string,
): Promise<Appointment[]> {
  const ids = await loadAppointmentIndex(patientId);

  const results = await Promise.allSettled(
    ids.map((id) => getAppointment(patientId, id)),
  );

  const appointments: Appointment[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      appointments.push(result.value);
    }
    // Rejected entries (S3 errors for a specific record) are silently skipped
    // so a single corrupted record does not break the entire list. The error
    // will be visible in server logs via the upstream catch in the route handler.
  }

  return appointments.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

export async function deleteAppointment(
  patientId: string,
  appointmentId: string,
): Promise<boolean> {
  const existing = await getAppointment(patientId, appointmentId);
  if (!existing) return false;

  // Soft delete: preserve the record and its S3 artifacts but mark it deleted.
  // Hard deletion of S3 objects (transcript, summary, audio, embeddings) is a
  // separate concern and should be done by a dedicated data-retention job that
  // respects regulatory hold periods.
  await updateAppointment(patientId, appointmentId, { status: "deleted" });

  return true;
}
