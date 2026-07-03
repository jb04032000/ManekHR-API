/**
 * One-time migration: backfill `attendanceDate` on AttendanceEvent documents
 * created before the cross-midnight shift field was introduced.
 *
 * Run: ts-node -r tsconfig-paths/register scripts/backfill-attendance-date.ts
 *
 * Strategy per event:
 *   CHECK_IN   → UTC midnight of timestamp (shift always starts on the punch day)
 *   Other types → look for an Attendance record whose date is today-or-yesterday
 *                 for that member, inherit its date.
 *                 Fallback: noon heuristic (hour < 12 UTC → previous day, else same day).
 */

import mongoose, { Types } from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/zari360';
const BATCH_SIZE = 500;

// ── Minimal schema shapes ────────────────────────────────────────────────────

const eventSchema = new mongoose.Schema({
  wsId:          { type: Types.ObjectId, required: true },
  teamMemberId:  { type: Types.ObjectId, default: null },
  timestamp:     { type: Date, required: true },
  punchType:     { type: String, required: true },
  attendanceDate: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: false });

const attendanceSchema = new mongoose.Schema({
  workspaceId:  { type: Types.ObjectId, required: true },
  teamMemberId: { type: Types.ObjectId, required: true },
  date:         { type: Date, required: true },
  checkIn:      { type: Date },
}, { strict: false });

const EventModel      = mongoose.model('AttendanceEvent', eventSchema, 'attendanceevents');
const AttendanceModel = mongoose.model('Attendance',      attendanceSchema, 'attendances');

// ── Helpers ──────────────────────────────────────────────────────────────────

function utcMidnight(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

function prevDay(d: Date): Date {
  const r = utcMidnight(d);
  r.setUTCDate(r.getUTCDate() - 1);
  return r;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB:', MONGODB_URI);

  const total = await EventModel.countDocuments({ attendanceDate: null });
  console.log(`Events to backfill: ${total}`);
  if (total === 0) { await mongoose.disconnect(); return; }

  let processed = 0;
  let updated   = 0;
  let cursor    = EventModel.find({ attendanceDate: null }).select('wsId teamMemberId timestamp punchType').lean().cursor();

  const bulk: mongoose.mongo.AnyBulkWriteOperation[] = [];

  const flush = async () => {
    if (bulk.length === 0) return;
    const res = await EventModel.bulkWrite(bulk as any[], { ordered: false });
    updated += res.modifiedCount;
    bulk.length = 0;
  };

  for await (const evt of cursor) {
    processed++;
    const ts        = evt.timestamp as Date;
    const today     = utcMidnight(ts);
    const yesterday = prevDay(ts);
    let attendanceDate: Date;

    if ((evt.punchType as string) === 'CHECK_IN') {
      attendanceDate = today;
    } else if (evt.teamMemberId) {
      // Look for an attendance record on today or yesterday
      const record = await AttendanceModel.findOne({
        workspaceId:  evt.wsId,
        teamMemberId: evt.teamMemberId,
        date: { $in: [today, yesterday] },
      })
        .select('date')
        .sort({ date: -1 })
        .lean<{ date: Date }>()
        .exec();

      if (record) {
        attendanceDate = utcMidnight(record.date);
      } else {
        // Noon heuristic: before noon UTC → previous night's shift
        attendanceDate = ts.getUTCHours() < 12 ? yesterday : today;
      }
    } else {
      attendanceDate = today;
    }

    bulk.push({
      updateOne: {
        filter: { _id: (evt as any)._id },
        update: { $set: { attendanceDate } },
      },
    });

    if (bulk.length >= BATCH_SIZE) await flush();

    if (processed % 1000 === 0) {
      console.log(`  processed ${processed}/${total}  updated so far: ${updated}`);
    }
  }

  await flush();
  console.log(`Done. Processed: ${processed}, Updated: ${updated}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
