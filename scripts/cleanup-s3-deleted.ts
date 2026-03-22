/**
 * Cleanup script — purge S3 artifacts for soft-deleted appointments.
 *
 * When an appointment is deleted via DELETE /api/appointments/:id, only the
 * metadata record is soft-deleted (status → "deleted"). The associated S3
 * objects (transcript, summary, embeddings) are NOT removed automatically
 * because:
 *  - Regulatory requirements may mandate a hold period before physical deletion.
 *  - An accidental delete should be recoverable without data loss.
 *
 * This script performs the physical cleanup after you've confirmed the hold
 * period has elapsed. Run it periodically (e.g. a Railway cron job or a
 * manual one-off) with the required AWS env vars.
 *
 * USAGE:
 *   npm run cleanup           — dry-run (no deletions)
 *   npm run cleanup -- --delete  — actually delete S3 objects
 *
 * What it does:
 *   1. Load the user email index from S3.
 *   2. For each user, load their appointment index.
 *   3. For each appointment with status="deleted", delete:
 *      - transcript file (_transcript.txt)
 *      - summary file (_summary.json)
 *      - The appointment metadata record itself
 *   4. Remove the deleted appointment IDs from the user's index.
 *   NOTE: The per-patient embedding index is NOT modified here because it is
 *   rebuilt atomically on every re-index. Stale embedding chunks for a deleted
 *   appointment are harmless — they will be evicted the next time any
 *   appointment is indexed for that patient.
 */

import "dotenv/config";
import { buildS3Key, buildSystemKey, downloadFromS3, uploadToS3, deleteFromS3 } from "../src/lib/s3";
import type { Appointment } from "../src/types";

const DRY_RUN = !process.argv.includes("--delete");

function log(msg: string) {
  console.log(`[cleanup] ${msg}`);
}

async function loadJson<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await downloadFromS3(key)) as T;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n🗑  Momentum S3 cleanup — soft-deleted appointments`);
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (pass --delete to actually remove)" : "DELETING"}\n`);

  // 1. Load user index: { [email]: userId }
  const userIndex = await loadJson<Record<string, string>>(
    buildSystemKey("users/index.json"),
  );
  if (!userIndex) {
    log("User index not found — nothing to clean.");
    return;
  }

  const userIds = [...new Set(Object.values(userIndex))];
  log(`Found ${userIds.length} user(s) to check.`);

  let totalDeleted = 0;
  let totalSkipped = 0;

  for (const userId of userIds) {
    const indexKey = buildS3Key(userId, "appointments", "index.json");
    const appointmentIds = await loadJson<string[]>(indexKey);
    if (!appointmentIds || appointmentIds.length === 0) continue;

    const survivingIds: string[] = [];

    for (const apptId of appointmentIds) {
      const metaKey = buildS3Key(userId, "appointments", `${apptId}.json`);
      const appt = await loadJson<Appointment>(metaKey);

      if (!appt || appt.status !== "deleted") {
        survivingIds.push(apptId);
        continue;
      }

      log(`  → user=${userId.slice(0, 8)}… appt=${apptId.slice(0, 8)}… [DELETED]`);

      const keysToDelete: string[] = [
        buildS3Key(userId, "transcripts", `${apptId}_transcript.txt`),
        buildS3Key(userId, "summaries", `${apptId}_summary.json`),
        metaKey, // the appointment record itself
      ];

      for (const key of keysToDelete) {
        if (DRY_RUN) {
          log(`     would delete: ${key}`);
        } else {
          try {
            await deleteFromS3(key);
            log(`     deleted: ${key}`);
          } catch {
            log(`     (skip — not found): ${key}`);
          }
        }
      }

      totalDeleted++;
    }

    // Update the index to remove deleted appointment IDs.
    if (!DRY_RUN && survivingIds.length !== appointmentIds.length) {
      await uploadToS3(
        indexKey,
        JSON.stringify(survivingIds),
        "application/json",
        { category: "appointments", patientId: userId },
      );
      log(`  → Updated appointment index for user ${userId.slice(0, 8)}…`);
    }

    totalSkipped += appointmentIds.length - (appointmentIds.length - survivingIds.length);
  }

  console.log(`\n✅  Done.`);
  console.log(`   Deleted appointments processed: ${totalDeleted}`);
  console.log(`   Active appointments skipped:    ${totalSkipped}`);
  if (DRY_RUN) {
    console.log(`\n   Re-run with --delete to perform actual removal.\n`);
  }
}

main().catch((err) => {
  console.error("\n❌  Cleanup failed:", err);
  process.exit(1);
});
