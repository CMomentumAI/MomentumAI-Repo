import "server-only";

import { Pool } from "pg";
import type { OmiTranscriptSegment } from "@/types";

export interface StoredRealtimeTranscriptSession {
  id: string;
  omiUid: string;
  sessionId: string;
  transcriptText: string;
  transcriptSegments: OmiTranscriptSegment[];
  segmentCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isNew: boolean;
}

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for OMI transcript storage");
  }
  return databaseUrl;
}

function getPool(): Pool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: getDatabaseUrl(),
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await getPool().query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS omi_realtime_transcript_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          omi_uid TEXT NOT NULL,
          session_id TEXT NOT NULL,
          transcript_text TEXT NOT NULL DEFAULT '',
          transcript_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
          segment_count INTEGER NOT NULL DEFAULT 0,
          started_at TIMESTAMPTZ NULL,
          finished_at TIMESTAMPTZ NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (omi_uid, session_id)
        );

        CREATE INDEX IF NOT EXISTS omi_realtime_transcript_sessions_updated_at_idx
          ON omi_realtime_transcript_sessions (updated_at DESC);
      `);
    })();
  }

  return schemaReady;
}

function normalizeTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function saveRealtimeTranscriptSession(input: {
  omiUid: string;
  sessionId: string;
  transcriptText: string;
  transcriptSegments: OmiTranscriptSegment[];
  startedAt?: string;
  finishedAt?: string;
}): Promise<StoredRealtimeTranscriptSession> {
  await ensureSchema();

  const startedAt = normalizeTimestamp(input.startedAt);
  const finishedAt = normalizeTimestamp(input.finishedAt);
  const segmentCount = input.transcriptSegments.length;
  const transcriptSegments = JSON.stringify(input.transcriptSegments);

  const existing = await getPool().query<{
    id: string;
    omi_uid: string;
    session_id: string;
    transcript_text: string;
    transcript_segments: OmiTranscriptSegment[];
    segment_count: number;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT
        id,
        omi_uid,
        session_id,
        transcript_text,
        transcript_segments,
        segment_count,
        started_at,
        finished_at,
        created_at,
        updated_at
      FROM omi_realtime_transcript_sessions
      WHERE omi_uid = $1 AND session_id = $2
      LIMIT 1
    `,
    [input.omiUid, input.sessionId],
  );

  if (existing.rowCount && existing.rows[0]) {
    const updated = await getPool().query<{
      id: string;
      omi_uid: string;
      session_id: string;
      transcript_text: string;
      transcript_segments: OmiTranscriptSegment[];
      segment_count: number;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `
        UPDATE omi_realtime_transcript_sessions
        SET
          transcript_text = $3,
          transcript_segments = $4::jsonb,
          segment_count = $5,
          started_at = COALESCE($6::timestamptz, started_at),
          finished_at = COALESCE($7::timestamptz, finished_at),
          updated_at = NOW()
        WHERE omi_uid = $1 AND session_id = $2
        RETURNING
          id,
          omi_uid,
          session_id,
          transcript_text,
          transcript_segments,
          segment_count,
          started_at,
          finished_at,
          created_at,
          updated_at
      `,
      [
        input.omiUid,
        input.sessionId,
        input.transcriptText,
        transcriptSegments,
        segmentCount,
        startedAt,
        finishedAt,
      ],
    );

    const row = updated.rows[0];
    return {
      id: row.id,
      omiUid: row.omi_uid,
      sessionId: row.session_id,
      transcriptText: row.transcript_text,
      transcriptSegments: row.transcript_segments,
      segmentCount: row.segment_count,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isNew: false,
    };
  }

  const inserted = await getPool().query<{
    id: string;
    omi_uid: string;
    session_id: string;
    transcript_text: string;
    transcript_segments: OmiTranscriptSegment[];
    segment_count: number;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      INSERT INTO omi_realtime_transcript_sessions (
        omi_uid,
        session_id,
        transcript_text,
        transcript_segments,
        segment_count,
        started_at,
        finished_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)
      RETURNING
        id,
        omi_uid,
        session_id,
        transcript_text,
        transcript_segments,
        segment_count,
        started_at,
        finished_at,
        created_at,
        updated_at
    `,
    [
      input.omiUid,
      input.sessionId,
      input.transcriptText,
      transcriptSegments,
      segmentCount,
      startedAt,
      finishedAt,
    ],
  );

  const row = inserted.rows[0];
  return {
    id: row.id,
    omiUid: row.omi_uid,
    sessionId: row.session_id,
    transcriptText: row.transcript_text,
    transcriptSegments: row.transcript_segments,
    segmentCount: row.segment_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isNew: true,
  };
}
