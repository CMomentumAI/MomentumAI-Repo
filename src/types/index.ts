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

export type AppointmentStatus = "pending" | "summarized" | "error";

export interface Appointment {
  id: string;
  patientId: string;
  title: string;
  doctorName?: string;
  specialty?: string;
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
  createdAt: string;
  updatedAt: string;
}

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
