/**
 * Appointment data store backed by S3.
 */

import { v4 as uuidv4 } from "uuid";
import { buildS3Key, uploadToS3, downloadFromS3 } from "./s3";
import type { Appointment } from "@/types";

// ─── Key helpers ─────────────────────────────────────────────────────────────

function appointmentMetaKey(patientId: string, appointmentId: string): string {
  return buildS3Key(patientId, "transcripts", `${appointmentId}_meta.json`);
}

function appointmentIndexKey(patientId: string): string {
  return `patients/${patientId}/appointments_index.json`;
}

// ─── Index ───────────────────────────────────────────────────────────────────

async function loadAppointmentIndex(
  patientId: string,
): Promise<string[]> {
  try {
    const raw = await downloadFromS3(appointmentIndexKey(patientId));
    return JSON.parse(raw) as string[];
  } catch {
    return [];
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
    );
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createAppointment(
  patientId: string,
  data: Partial<Appointment>,
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
    summary: data.summary,
    keyPoints: data.keyPoints ?? [],
    prescriptions: data.prescriptions ?? [],
    followUps: data.followUps ?? [],
    status: data.status ?? "pending",
    audioS3Key: data.audioS3Key,
    transcriptS3Key: data.transcriptS3Key,
    summaryS3Key: data.summaryS3Key,
    embeddingS3Key: data.embeddingS3Key,
    createdAt: now,
    updatedAt: now,
  };

  await uploadToS3(
    appointmentMetaKey(patientId, id),
    JSON.stringify(appointment),
  );
  await appendToIndex(patientId, id);

  return appointment;
}

export async function getAppointment(
  patientId: string,
  appointmentId: string,
): Promise<Appointment | null> {
  try {
    const raw = await downloadFromS3(
      appointmentMetaKey(patientId, appointmentId),
    );
    return JSON.parse(raw) as Appointment;
  } catch {
    return null;
  }
}

export async function updateAppointment(
  patientId: string,
  appointmentId: string,
  updates: Partial<Appointment>,
): Promise<Appointment | null> {
  const existing = await getAppointment(patientId, appointmentId);
  if (!existing) return null;

  const updated: Appointment = {
    ...existing,
    ...updates,
    id: existing.id,
    patientId: existing.patientId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await uploadToS3(
    appointmentMetaKey(patientId, appointmentId),
    JSON.stringify(updated),
  );

  return updated;
}

export async function listAppointments(
  patientId: string,
): Promise<Appointment[]> {
  const ids = await loadAppointmentIndex(patientId);

  const appointments = await Promise.all(
    ids.map((id) => getAppointment(patientId, id)),
  );

  return appointments
    .filter((a): a is Appointment => a !== null)
    .sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
}

export async function deleteAppointment(
  patientId: string,
  appointmentId: string,
): Promise<boolean> {
  const existing = await getAppointment(patientId, appointmentId);
  if (!existing) return false;

  // Soft delete: mark as deleted in metadata
  await updateAppointment(patientId, appointmentId, {
    status: "error",
    title: `[Deleted] ${existing.title}`,
  });

  return true;
}
