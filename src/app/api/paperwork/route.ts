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
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getAppointment, listAppointments } from "@/lib/appointments";
import { getUserById } from "@/lib/users";
import { requireAuth, successResponse, errorResponse } from "@/lib/api-helpers";
import type { PaperworkResponse } from "@/types";

const FORM_TYPES = ["intake", "prescription", "referral", "insurance"] as const;

const PaperworkSchema = z.object({
  formType: z.enum(FORM_TYPES),
  appointmentId: z.string().uuid().optional(),
});

function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  return new GoogleGenerativeAI(apiKey);
}

const FORM_TEMPLATES: Record<string, string> = {
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

async function autoFillForm(
  formType: string,
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

  const result = await model.generateContent(prompt);
  const content = result.response.text();

  const cleaned = content
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();

  const parsed = JSON.parse(cleaned) as { fields: PaperworkResponse["fields"] };

  return {
    formType,
    fields: parsed.fields,
    generatedAt: new Date().toISOString(),
  };
}

export async function POST(request: NextRequest) {
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;
  const { user } = authResult;

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

    // Build patient context from profile + appointment history
    const [patient, appointments] = await Promise.all([
      getUserById(user.sub),
      listAppointments(user.sub),
    ]);

    let specificAppointment = null;
    if (appointmentId) {
      specificAppointment = await getAppointment(user.sub, appointmentId);
    }

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
          ?.map((p) => `${p.medication} ${p.dosage} ${p.frequency} — ${p.notes ?? ""}`)
          .join("\n") ?? "none"
      }`
    : ""
}

Recent Appointment History:
${summaries || "No appointment history available"}
    `.trim();

    const formData = await autoFillForm(formType, patientContext);

    return successResponse(formData);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Paperwork generation failed";
    console.error("[paperwork:POST]", error);

    if (message.includes("GEMINI_API_KEY")) {
      return errorResponse("AI service is not configured", 503);
    }

    return errorResponse("Failed to generate paperwork", 500);
  }
}
