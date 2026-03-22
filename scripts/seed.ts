/**
 * Demo data seed script for Momentum AI.
 *
 * Creates one clearly fictional demo patient and two synthetic appointments
 * with pre-written summaries. All data is obviously fake and safe for use
 * in public demos, screenshots, and hackathon presentations.
 *
 * USAGE:
 *   npm run seed
 *   # or: npx tsx scripts/seed.ts
 *
 * REQUIREMENTS:
 *   AWS credentials and S3 bucket must be configured (same env vars used by
 *   the app). AI API keys are NOT required — summaries are pre-written.
 *
 * IDEMPOTENCY:
 *   If the demo user already exists (email already in the index), the script
 *   skips user creation and reports the existing userId. Appointments are
 *   always created fresh so running the script multiple times will add more
 *   appointments for the demo user.
 *
 * DEMO CREDENTIALS:
 *   Email:    demo@momentum.health
 *   Password: Demo1234!
 *
 * ⚠️  This user and all their data are fictional and intended for demo purposes
 * only. Do not use real patient data in this script.
 */

// Load .env.local / .env for local development.
// In production (Railway) the env vars are injected directly.
import "dotenv/config";

import { createUser, getUserByEmail } from "../src/lib/users";
import { createAppointment, updateAppointment } from "../src/lib/appointments";
import { buildS3Key, uploadToS3 } from "../src/lib/s3";

// ─── Demo patient ─────────────────────────────────────────────────────────────

const DEMO_EMAIL = "demo@momentum.health";
const DEMO_PASSWORD = "Demo1234!";
const DEMO_NAME = "Jordan Rivera";
const DEMO_DOB = "1988-06-21";

// ─── Synthetic appointment data ───────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

interface SeedAppointment {
  title: string;
  doctorName: string;
  specialty: string;
  date: string;
  transcript: string;
  summary: {
    summary: string;
    keyPoints: string[];
    prescriptions: {
      medication: string;
      dosage: string;
      frequency: string;
      notes?: string;
    }[];
    followUps: string[];
  };
}

const SEED_APPOINTMENTS: SeedAppointment[] = [
  {
    title: "Annual Physical Examination",
    doctorName: "Dr. Patricia Nguyen",
    specialty: "Internal Medicine",
    date: daysAgo(90),
    transcript: `Dr. Nguyen: Good morning, Jordan! How have you been feeling since your last visit?
Patient: Pretty good overall, just a little more tired than usual lately.
Dr. Nguyen: Let's check your vitals. Blood pressure is 118 over 76 — that's excellent.
Patient: Great, I was a bit worried about that.
Dr. Nguyen: Your cholesterol panel came back and everything is within normal range. Total cholesterol 185, LDL 110, HDL 58.
Patient: That's a relief. I've been trying to eat healthier.
Dr. Nguyen: It shows! I do notice your vitamin D level is slightly low — 28 ng/mL. The normal range is 30 to 100.
Patient: Should I be taking a supplement?
Dr. Nguyen: Yes, I'd recommend 2000 IU of vitamin D3 daily. You can pick that up over the counter.
Patient: Okay, I'll do that.
Dr. Nguyen: Also, are you up to date on your flu vaccine?
Patient: I don't think I got one this year.
Dr. Nguyen: We'll take care of that today. Any other concerns?
Patient: Not really. Maybe just the fatigue.
Dr. Nguyen: The vitamin D should help with that. If it doesn't improve in a month or two, come back and we'll run some more tests. Otherwise everything looks great for a person your age.
Patient: Thank you so much, Dr. Nguyen.`,
    summary: {
      summary:
        "Annual physical for Jordan Rivera was generally positive. Blood pressure and cholesterol are within healthy ranges. Vitamin D is mildly deficient at 28 ng/mL; supplementation recommended. Flu vaccine administered during visit.",
      keyPoints: [
        "Blood pressure 118/76 — excellent",
        "Total cholesterol 185 (normal), LDL 110, HDL 58",
        "Vitamin D level low at 28 ng/mL (normal: 30–100)",
        "Flu vaccine administered",
        "Patient reports mild fatigue — likely related to vitamin D deficiency",
      ],
      prescriptions: [
        {
          medication: "Vitamin D3",
          dosage: "2000 IU",
          frequency: "Once daily",
          notes: "Over-the-counter, take with a meal for better absorption",
        },
      ],
      followUps: [
        "Return in 2–3 months if fatigue does not improve with supplementation",
        "Repeat vitamin D level at next annual physical",
      ],
    },
  },
  {
    title: "Follow-Up: Fatigue & Vitamin D",
    doctorName: "Dr. Patricia Nguyen",
    specialty: "Internal Medicine",
    date: daysAgo(30),
    transcript: `Dr. Nguyen: Hi Jordan, it's good to see you again. How has the fatigue been?
Patient: Much better, actually! I've been taking the vitamin D every morning and I can feel a difference.
Dr. Nguyen: That's wonderful. Let's check your blood pressure again — 122 over 78. Still excellent.
Patient: I've also been sleeping a bit better.
Dr. Nguyen: Vitamin D can definitely improve sleep quality. I'm glad to hear it. Have you had any side effects from the supplement?
Patient: No, none at all.
Dr. Nguyen: Perfect. Any new concerns since your last visit?
Patient: I've had some mild knee pain after running. Nothing severe, just a little stiffness.
Dr. Nguyen: How long has that been going on?
Patient: About three weeks. It comes and goes.
Dr. Nguyen: That could be patellofemoral syndrome — runner's knee. It's very common. Try reducing your mileage by about 20%, add some strengthening exercises for your quads, and take ibuprofen as needed for the pain.
Patient: Should I see an orthopedic specialist?
Dr. Nguyen: Not yet. Give these modifications 4 to 6 weeks. If the pain persists or worsens, we'll refer you to orthopedics. Otherwise, continue the vitamin D and keep up the healthy habits.
Patient: Thank you, Dr. Nguyen!`,
    summary: {
      summary:
        "Follow-up visit confirms improvement in fatigue following vitamin D supplementation. Blood pressure remains excellent at 122/78. Patient reports new onset of mild knee pain after running, consistent with patellofemoral syndrome. Conservative management recommended.",
      keyPoints: [
        "Fatigue significantly improved with vitamin D supplementation",
        "Blood pressure 122/78 — still excellent",
        "Mild knee pain (3 weeks duration) — likely patellofemoral syndrome",
        "No new medications required",
      ],
      prescriptions: [
        {
          medication: "Ibuprofen",
          dosage: "400 mg",
          frequency: "As needed for knee pain (max 3x per day with food)",
          notes: "Not for long-term daily use without medical supervision",
        },
      ],
      followUps: [
        "Reduce running mileage by 20% and add quad strengthening exercises",
        "Return in 4–6 weeks if knee pain persists or worsens",
        "Orthopedics referral if conservative treatment fails",
        "Continue vitamin D 2000 IU daily",
      ],
    },
  },
];

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

function warn(msg: string) {
  console.warn(`[seed] ⚠️  ${msg}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱  Momentum AI — Demo Data Seed\n");
  console.log(
    "  All data is fictional and intended for hackathon/demo use only.\n",
  );

  // ── Create or find the demo user ─────────────────────────────────────────

  let demoUserId: string;

  const existingUser = await getUserByEmail(DEMO_EMAIL);
  if (existingUser) {
    warn(`Demo user already exists (id: ${existingUser.id}) — skipping creation.`);
    demoUserId = existingUser.id;
  } else {
    log(`Creating demo user: ${DEMO_EMAIL}`);
    const patient = await createUser(DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME);

    // Update profile with date of birth (createUser doesn't accept it directly)
    // We import updateUserProfile from users.ts
    const { updateUserProfile } = await import("../src/lib/users");
    await updateUserProfile(patient.id, { dateOfBirth: DEMO_DOB });

    demoUserId = patient.id;
    log(`✓ Demo user created (id: ${demoUserId})`);
  }

  log(`\nDemo credentials:`);
  log(`  Email:    ${DEMO_EMAIL}`);
  log(`  Password: ${DEMO_PASSWORD}`);

  // ── Create appointments ───────────────────────────────────────────────────

  log(`\nCreating ${SEED_APPOINTMENTS.length} seed appointments...`);

  for (const appt of SEED_APPOINTMENTS) {
    log(`\n  → ${appt.title} (${appt.doctorName})`);

    // 1. Create appointment record with status "pending"
    const appointment = await createAppointment(demoUserId, {
      title: appt.title,
      doctorName: appt.doctorName,
      specialty: appt.specialty,
      date: appt.date,
      status: "pending",
    });

    log(`    Created appointment id: ${appointment.id}`);

    // 2. Upload transcript to S3
    const transcriptKey = buildS3Key(
      demoUserId,
      "transcripts",
      `${appointment.id}_transcript.txt`,
    );
    await uploadToS3(transcriptKey, appt.transcript, "text/plain", {
      category: "transcripts",
      patientId: demoUserId,
    });

    log(`    Uploaded transcript (${Buffer.byteLength(appt.transcript, "utf-8")} bytes)`);

    // 3. Upload pre-written summary to S3 (no AI API call required)
    const summaryPayload = JSON.stringify(appt.summary, null, 2);
    const summarySizeBytes = Buffer.byteLength(summaryPayload, "utf-8");
    const summaryKey = buildS3Key(
      demoUserId,
      "summaries",
      `${appointment.id}_summary.json`,
    );
    await uploadToS3(summaryKey, summaryPayload, "application/json", {
      category: "summaries",
      patientId: demoUserId,
    });

    log(`    Uploaded summary (${summarySizeBytes} bytes)`);

    // 4. Update appointment record with all results — mark as summarized
    await updateAppointment(demoUserId, appointment.id, {
      rawTranscript: appt.transcript,
      transcriptS3Key: transcriptKey,
      transcriptSizeBytes: Buffer.byteLength(appt.transcript, "utf-8"),
      summary: appt.summary.summary,
      keyPoints: appt.summary.keyPoints,
      prescriptions: appt.summary.prescriptions,
      followUps: appt.summary.followUps,
      summaryS3Key: summaryKey,
      summarySizeBytes,
      // Mark as seeded — no real AI model was used
      processingModel: "seed/static",
      processingCompletedAt: new Date().toISOString(),
      status: "summarized",
    });

    log(`    ✓ Appointment marked as summarized`);
  }

  console.log("\n✅  Seed complete!\n");
  console.log("  Note: RAG/chat will not work until you re-summarize the");
  console.log("  appointments via POST /api/appointments/{id}/summarize");
  console.log("  (requires GEMINI_API_KEY to build the embedding index).\n");
}

main().catch((err) => {
  console.error("\n❌  Seed failed:", err);
  process.exit(1);
});
