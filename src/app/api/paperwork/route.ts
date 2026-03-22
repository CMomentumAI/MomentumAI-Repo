/**
 * POST /api/paperwork
 *
 * Auto-fill paperwork/medical forms using Gemini with patient history context.
 *
 * Request body:
 *  { formType: string, appointmentId?: string }
 *
 * Supported form types:
 *  - "intake"        Patient intake form
 *  - "prescription"  Prescription details from last appointment
 *  - "referral"      Referral letter
 *  - "insurance"     Insurance pre-authorization
 *
 * Context source: patient profile + up to 5 most recent summarized appointments.
 * If appointmentId is supplied it must belong to the authenticated patient;
 * a 404 is returned if it does not exist or has been soft-deleted.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getAppointment, listAppointments } from "@/lib/appointments";
import { getUserById } from "@/lib/users";
import { getEnv } from "@/lib/env";
import {
  requireAuth,
  successResponse,
  errorResponse,
  rateLimitResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";
import { withTimeoutPromise } from "@/lib/resilience";
import { apiLimiter } from "@/lib/rate-limit";
import type { PaperworkResponse } from "@/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const FORM_TYPES = ["intake", "prescription", "referral", "insurance"] as const;

/** Hard timeout for Gemini form-fill generation. */
const GEMINI_TIMEOUT_MS = 45_000;

// ─── Validation ───────────────────────────────────────────────────────────────

const PaperworkSchema = z.object({
  formType: z.enum(FORM_TYPES),
  appointmentId: z.string().uuid().optional(),
});

// ─── Gemini client ────────────────────────────────────────────────────────────

function getGeminiClient(): GoogleGenerativeAI {
  const { GEMINI_API_KEY } = getEnv();
  return new GoogleGenerativeAI(GEMINI_API_KEY);
}

// ─── Form templates ───────────────────────────────────────────────────────────

const FORM_TEMPLATES: Record<(typeof FORM_TYPES)[number], string> = {
  intake: `Fill out a patient intake form with the following fields:
    - patientName (text)
    - dateOfBirth (date)
    - chiefComplaint (text)
    - currentMedications (text, list all medications)
    - allergies (text)
    - medicalHistory (text)
    - primaryCarePhysician (text)
    - reasonForVisit (text)`,

  prescription: `Fill out prescription information with:
    - medicationName (text)
    - dosage (text)
    - frequency (text)
    - duration (text)
    - prescribingDoctor (text)
    - datePrescribed (date)
    - refillsRemaining (text)
    - specialInstructions (text)`,

  referral: `Fill out a referral letter with:
    - patientName (text)
    - referringDoctor (text)
    - specialistType (text)
    - reasonForReferral (text)
    - urgency (select: routine, urgent, emergent)
    - relevantHistory (text)
    - currentMedications (text)
    - insuranceInfo (text)`,

  insurance: `Fill out an insurance pre-authorization with:
    - patientName (text)
    - memberId (text)
    - groupNumber (text)
    - diagnosis (text)
    - requestedProcedure (text)
    - requestedMedication (text)
    - clinicalJustification (text)
    - treatingPhysician (text)`,
};

// ─── AI form-fill ─────────────────────────────────────────────────────────────

async function autoFillForm(
  formType: (typeof FORM_TYPES)[number],
  patientContext: string,
): Promise<PaperworkResponse> {
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  const template = FORM_TEMPLATES[formType];
  const prompt = `You are a medical assistant helping auto-fill a ${formType} form.

Based on the following patient context, extract and fill out the form fields.
Return ONLY valid JSON in this exact format:
{
  "fields": [
    { "fieldName": "...", "fieldType": "text|date|checkbox|select", "label": "...", "value": "..." }
  ]
}

Form fields to fill:
${template}

Patient context:
${patientContext}

If information is not available, leave the value as an empty string.`;

  const result = await withTimeoutPromise(
    model.generateContent(prompt),
    GEMINI_TIMEOUT_MS,
    "gemini-paperwork",
  );
  const content = result.response.text();

  const cleaned = content
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as { fields: PaperworkResponse["fields"] };
    if (!Array.isArray(parsed?.fields)) {
      throw new Error("Response missing fields array");
    }
    return { formType, fields: parsed.fields, generatedAt: new Date().toISOString() };
  } catch {
    // Gemini occasionally returns prose instead of JSON. Return an empty form
    // rather than a 500 so the user at least gets a usable (if unfilled) form.
    logger.warn("paperwork", "Gemini returned non-JSON; serving empty form", {
      formType,
    });
    return { formType, fields: [], generatedAt: new Date().toISOString() };
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

  // Per-user rate limit — form-fill calls are Gemini API calls.
  const rl = apiLimiter.check(user.sub);
  if (!rl.allowed) {
    logger.warn("paperwork:POST", "Rate limit exceeded", { requestId, userId: user.sub });
    return rateLimitResponse(rl.resetAt);
  }

  try {
    const body = await request.json();
    const parsed = PaperworkSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const { formType, appointmentId } = parsed.data;

    // If the caller specified an appointment, fetch and verify ownership first.
    // getAppointment() scopes the S3 key to user.sub, so the ownership is
    // enforced at the storage layer; the explicit null check surfaces a 404
    // rather than silently omitting the appointment-specific context.
    let specificAppointment = null;
    if (appointmentId) {
      specificAppointment = await getAppointment(user.sub, appointmentId);
      if (!specificAppointment) {
        return errorResponse("Appointment not found", 404);
      }
    }

    const [patient, appointments] = await Promise.all([
      getUserById(user.sub),
      listAppointments(user.sub),
    ]);

    const recentAppointments = appointments.slice(0, 5);
    const summaries = recentAppointments
      .filter((a) => a.summary)
      .map(
        (a) =>
          `Date: ${new Date(a.date).toLocaleDateString()}\nSummary: ${a.summary}\nPrescriptions: ${
            a.prescriptions
              ?.map((p) => `${p.medication} ${p.dosage} ${p.frequency}`)
              .join(", ") ?? "none"
          }`,
      )
      .join("\n\n");

    const patientContext = `
Patient Name: ${patient?.name ?? "Unknown"}
Date of Birth: ${patient?.dateOfBirth ?? "Not provided"}

${
  specificAppointment
    ? `Most Relevant Appointment:\n${specificAppointment.summary ?? specificAppointment.rawTranscript ?? ""}\n\nPrescriptions from this appointment:\n${
        specificAppointment.prescriptions
          ?.map(
            (p) =>
              `${p.medication} ${p.dosage} ${p.frequency}${p.notes ? ` — ${p.notes}` : ""}`,
          )
          .join("\n") ?? "none"
      }`
    : ""
}

Recent Appointment History:
${summaries || "No appointment history available"}
    `.trim();

    const formData = await autoFillForm(formType, patientContext);

    logger.info("paperwork:POST", "Paperwork generated", {
      requestId,
      userId: user.sub,
      formType,
      appointmentId: appointmentId ?? null,
      fieldCount: formData.fields.length,
    });

    return successResponse(formData);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Paperwork generation failed";
    logger.error("paperwork:POST", "Paperwork generation failed", error, {
      requestId,
      userId: user.sub,
    });

    if (message.includes("GEMINI_API_KEY")) {
      return errorResponse("AI service is not configured", 503);
    }

    return errorResponse("Failed to generate paperwork", 500);
  }
}
