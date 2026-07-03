/* eslint-disable no-console */
/**
 * Phase A migration: backfill AttendanceEvent rows from existing Attendance rows.
 *
 * Decision D11 (LOCKED) mapping:
 *   For each existing Attendance row, create one AttendanceEvent with:
 *     punchType    = 'STATUS_SET'
 *     statusValue  = attendance.status
 *     source       = attendance.autoMarked ? 'auto_cron' : 'manual'
 *     timestamp    = attendance.checkIn || attendance.date
 *     markedBy     = attendance.markedBy
 *   Then set dominantSource, lastComputedAt, projectionVersion = 1 on the Attendance row.
 *
 * Deployment order:
 * 1. Take a DB snapshot / backup
 * 2. DRY RUN (no writes, prints counts):
 *      npx ts-node -r tsconfig-paths/register scripts/migrate-attendance-events.ts --dry-run
 * 3. Review stdout output carefully
 * 4. LIVE RUN (writes events + updates projection metadata):
 *      npx ts-node -r tsconfig-paths/register scripts/migrate-attendance-events.ts --live
 *
 * NEVER run --live without reviewing --dry-run output first.
 *
 * Rollback:
 * - If dry-run looks wrong, stop before live run.
 * - If live run behaves unexpectedly, restore the DB snapshot from step 1.
 * - Dropping the AttendanceEvent collection is safe (projection fields on
 *   Attendance are nullable and ignored by existing consumers).
 *
 * The script is idempotent: rows with an existing migration event are skipped.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  'mongodb://localhost:27017/zari360';

const DRY_RUN = process.argv.includes('--dry-run');
const LIVE = process.argv.includes('--live');

if (DRY_RUN === LIVE) {
  // Both present or neither present — either way, ambiguous.
  console.error(
    'ERROR: exactly one of --dry-run or --live must be passed.\n' +
      '  Dry run:  npx ts-node -r tsconfig-paths/register scripts/migrate-attendance-events.ts --dry-run\n' +
      '  Live run: npx ts-node -r tsconfig-paths/register scripts/migrate-attendance-events.ts --live',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Minimal inline schemas — avoids importing NestJS/Mongoose decorators which
// require the full Nest DI container to bootstrap.
// ---------------------------------------------------------------------------

const AttendanceSchema = new mongoose.Schema(
  {
    workspaceId: mongoose.Schema.Types.ObjectId,
    teamMemberId: mongoose.Schema.Types.ObjectId,
    date: Date,
    status: String,
    checkIn: Date,
    checkOut: Date,
    note: String,
    markedBy: mongoose.Schema.Types.ObjectId,
    autoMarked: Boolean,
    dominantSource: String,
    lastComputedAt: Date,
    projectionVersion: Number,
  },
  { strict: false, collection: 'attendances' },
);

const AttendanceEventSchema = new mongoose.Schema(
  {
    wsId: mongoose.Schema.Types.ObjectId,
    teamMemberId: mongoose.Schema.Types.ObjectId,
    deviceSerial: { type: String, default: null },
    deviceUserId: { type: String, default: null },
    timestamp: Date,
    punchType: String,
    statusValue: String,
    verifyMethod: String,
    source: String,
    sourceMeta: Object,
    markedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    note: String,
    correctsEventId: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdAt: Date,
  },
  { strict: false, collection: 'attendanceevents' },
);

// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;

async function main(): Promise<void> {
  console.log(
    `[Migration] Starting attendance event backfill (${DRY_RUN ? 'DRY RUN' : 'LIVE'})`,
  );
  console.log(
    '[Migration] Connecting to:',
    MONGODB_URI.replace(/\/\/.*@/, '//***@'),
  );

  await mongoose.connect(MONGODB_URI);
  const conn = mongoose.connection;

  const Attendance = conn.model('Attendance', AttendanceSchema);
  const AttendanceEvent = conn.model('AttendanceEvent', AttendanceEventSchema);

  const totalAttendance = await Attendance.countDocuments({});
  const alreadyMigratedTotal = await AttendanceEvent.countDocuments({
    'sourceMeta.migratedFromAttendanceId': { $exists: true },
  });

  console.log(`[Migration] Total Attendance rows:         ${totalAttendance}`);
  console.log(
    `[Migration] Already-migrated events exist: ${alreadyMigratedTotal}`,
  );

  // Counters
  let planned = 0;
  let skippedAlreadyHasEvent = 0;
  let skippedMissingStatus = 0;
  let written = 0;
  let projectionUpdated = 0;

  // Accumulate a batch then flush
  const batchEvents: Record<string, unknown>[] = [];
  const batchProjectionOps: Record<string, unknown>[] = [];

  const flushBatch = async (): Promise<void> => {
    if (DRY_RUN) {
      // In dry-run mode, just clear the in-memory arrays — nothing is written.
      batchEvents.length = 0;
      batchProjectionOps.length = 0;
      return;
    }

    if (batchEvents.length > 0) {
      await AttendanceEvent.insertMany(batchEvents, { ordered: false });
      written += batchEvents.length;
    }

    if (batchProjectionOps.length > 0) {
      await Attendance.bulkWrite(batchProjectionOps as Parameters<typeof Attendance.bulkWrite>[0]);
      projectionUpdated += batchProjectionOps.length;
    }

    batchEvents.length = 0;
    batchProjectionOps.length = 0;
  };

  // Cursor-based iteration — avoids loading all Attendance docs into memory.
  const cursor = Attendance.find({}).cursor();

  for (
    let doc = await cursor.next();
    doc !== null;
    doc = await cursor.next()
  ) {
    const row = doc.toObject() as Record<string, unknown>;

    // Guard: every Attendance row must have a status value.
    const status = row.status as string | undefined;
    if (!status) {
      console.warn(
        `[Migration] WARN: Attendance row ${String(row._id)} has no status — skipping.`,
      );
      skippedMissingStatus += 1;
      continue;
    }

    // Idempotency check: skip if a migration event already exists for this row.
    // We identify migration events by sourceMeta.migratedFromAttendanceId.
    const existingCount = await AttendanceEvent.countDocuments({
      'sourceMeta.migratedFromAttendanceId': row._id,
    });
    if (existingCount > 0) {
      skippedAlreadyHasEvent += 1;
      continue;
    }

    // D11 LOCKED: timestamp fallback chain — checkIn takes priority, date is required.
    const timestamp =
      (row.checkIn as Date | undefined) ?? (row.date as Date);

    const autoMarked = Boolean(row.autoMarked);
    // D11 LOCKED: source mapping
    const source = autoMarked ? 'auto_cron' : 'manual';
    // D11 LOCKED: verifyMethod mirrors source intent
    const verifyMethod = autoMarked ? 'auto' : 'manual';

    // Threat mitigation: if markedBy is present but not a valid ObjectId, null it out.
    let markedBy: mongoose.Types.ObjectId | null = null;
    if (row.markedBy) {
      if (mongoose.isValidObjectId(row.markedBy)) {
        markedBy = row.markedBy as mongoose.Types.ObjectId;
      } else {
        console.warn(
          `[Migration] WARN: Attendance row ${String(row._id)} has invalid markedBy (${String(row.markedBy)}) — setting to null.`,
        );
      }
    }

    const ev: Record<string, unknown> = {
      wsId: row.workspaceId,
      teamMemberId: row.teamMemberId,
      deviceSerial: null,
      deviceUserId: null,
      timestamp,
      punchType: 'STATUS_SET',
      statusValue: status,
      verifyMethod,
      source,
      sourceMeta: {
        migratedFromAttendanceId: row._id,
        migratedAt: new Date(),
      },
      markedBy,
      note: (row.note as string | undefined) ?? null,
      correctsEventId: null,
      createdAt: new Date(),
    };

    batchEvents.push(ev);
    batchProjectionOps.push({
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            dominantSource: source,
            lastComputedAt: new Date(),
          },
          // $max ensures projectionVersion only moves forward (safe to re-run).
          $max: { projectionVersion: 1 },
        },
      },
    });
    planned += 1;

    if (batchEvents.length >= BATCH_SIZE) {
      await flushBatch();
      process.stdout.write(
        `\r[Migration] Processed ${planned} rows (written ${written} events)...`,
      );
    }
  }

  // Flush any remaining rows.
  await flushBatch();

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n');
  console.log('─────────────────────────── Migration summary ───────────────────────────');
  console.log(`Mode:                        ${LIVE ? 'LIVE' : 'DRY RUN'}`);
  console.log(`Total Attendance rows:       ${totalAttendance}`);
  console.log(`Planned new events:          ${planned}`);
  console.log(`Skipped (already migrated):  ${skippedAlreadyHasEvent}`);
  console.log(`Skipped (missing status):    ${skippedMissingStatus}`);

  if (LIVE) {
    console.log(`Events written:              ${written}`);
    console.log(`Projection rows updated:     ${projectionUpdated}`);
    console.log('─────────────────────────────────────────────────────────────────────────');
    console.log('[Migration] LIVE migration complete.');
  } else {
    console.log('─────────────────────────────────────────────────────────────────────────');
    console.log(
      'NO WRITES PERFORMED. Review these counts, then run again with --live.',
    );
    console.log(
      'Verification queries after live run:\n' +
        "  db.attendanceevents.countDocuments({'sourceMeta.migratedFromAttendanceId': {$exists: true}})\n" +
        '  db.attendances.countDocuments({projectionVersion: {$gte: 1}})',
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[Migration] ERROR:', err);
  process.exit(1);
});
