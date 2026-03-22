// ─── Patient / User ─────────────────────────────────────────────────────────

export interface Patient {
  id: string;
  email: string;
  name: string;
  dateOfBirth?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Appointment ─────────────────────────────────────────────────────────────

export type AppointmentStatus = "pending" | "summarized" | "error" | "deleted";

export interface Appointment {
  id: string;
  patientId: string;
  title: string;
  doctorName?: string;
  specialty?: string;
  /** Free-text clinical notes added by the patient or via PATCH. */
  notes?: string;
  date: string;
  rawTranscript?: string;
  summary?: string;
  keyPoints?: string[];
  prescriptions?: Prescription[];
  followUps?: string[];
  status: AppointmentStatus;
  audioS3Key?: string;
  transcriptS3Key?: string;
  summaryS3Key?: string;
  embeddingS3Key?: string;
  /** Byte size of the stored transcript object in S3, recorded at upload time. */
  transcriptSizeBytes?: number;
  /** Byte size of the stored summary object in S3, recorded at upload time. */
  summarySizeBytes?: number;
  // ─── AI processing metadata ─────────────────────────────────────────────────
  /** ISO timestamp when AI summarization was last started. */
  processingStartedAt?: string;
  /** ISO timestamp when AI summarization last completed successfully. */
  processingCompletedAt?: string;
  /** ISO timestamp of the most recent summarization failure. */
  processingFailedAt?: string;
  /**
   * Sanitized failure reason from the most recent summarization attempt.
   * Capped at 500 characters. Must never contain transcript content or PHI.
   */
  processingError?: string;
  /**
   * Model/provider used for the most recent successful summarization.
   * Example: "perplexity/llama-3.1-sonar-large-128k-online"
   */
  processingModel?: string;
  /**
   * OMI session_id that triggered this appointment via the webhook.
   * Used to detect and reject duplicate webhook deliveries.
   */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fields that callers may supply when creating a new appointment.
 * Immutable identity fields (id, patientId, createdAt) are excluded.
 */
export type AppointmentCreateInput = Pick<
  Appointment,
  | "title"
  | "doctorName"
  | "specialty"
  | "notes"
  | "date"
  | "rawTranscript"
  | "status"
>;

/**
 * Fields that callers may supply when updating an existing appointment.
 * Identity and immutable audit fields are excluded.
 */
export type AppointmentUpdate = Omit<
  Partial<Appointment>,
  "id" | "patientId" | "createdAt"
>;

export interface Prescription {
  medication: string;
  dosage: string;
  frequency: string;
  duration?: string;
  notes?: string;
}

// ─── OMI Webhook ─────────────────────────────────────────────────────────────

export interface OmiWebhookPayload {
  session_id: string;
  patient_id?: string;
  transcript: OmiTranscriptSegment[];
  started_at: string;
  finished_at: string;
}

export interface OmiTranscriptSegment {
  text: string;
  speaker: string;
  speaker_id: number;
  is_user: boolean;
  start: number;
  end: number;
}

// ─── RAG / Embeddings ────────────────────────────────────────────────────────

export interface EmbeddingRecord {
  appointmentId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface EmbeddingIndex {
  patientId: string;
  updatedAt: string;
  records: EmbeddingRecord[];
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
}

export interface ChatResponse {
  answer: string;
  sources?: string[];
}

// ─── Voice / TTS ─────────────────────────────────────────────────────────────

export interface TTSRequest {
  text: string;
  voiceId?: string;
}

// ─── Paperwork / Forms ───────────────────────────────────────────────────────

export interface PaperworkField {
  fieldName: string;
  fieldType: "text" | "date" | "checkbox" | "select";
  label: string;
  value?: string;
}

export interface PaperworkRequest {
  formType: string;
  appointmentId?: string;
}

export interface PaperworkResponse {
  formType: string;
  fields: PaperworkField[];
  generatedAt: string;
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiError {
  success: false;
  error: string;
  details?: unknown;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;
