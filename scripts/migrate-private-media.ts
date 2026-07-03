/**
 * One-time migration: move LEGACY private media (chat attachments + job-application
 * files) off the world-readable public bucket onto the PRIVATE bucket, and rewrite
 * every DB reference to a canonical `r2-private://<key>` ref.
 *
 * Scope (only categories that became private):
 *   - connect_messages.media[].url, connect_messages.audioUrl   (inbox)
 *   - connect_job_applications.voiceNoteUrl, .resumeUrl         (jobs)
 *   - upload_events.fileUrl                                     (ownership log)
 *
 * For each value it copies the object public -> private (same key), VERIFIES the
 * copy by size, then rewrites the DB reference. The public object is deleted ONLY
 * when --delete-source is passed (default: kept, so a bad run is recoverable).
 *
 * Idempotent + resumable: a value already `r2-private://...` is skipped, so re-running
 * after an interruption only touches the not-yet-migrated remainder. Offsite / unknown
 * URLs are never touched.
 *
 * Usage:
 *   # dry run - report what WOULD change, touch nothing:
 *   npx ts-node scripts/migrate-private-media.ts --dry-run
 *
 *   # real run - copy + verify + rewrite DB, KEEP the public originals:
 *   npx ts-node scripts/migrate-private-media.ts
 *
 *   # real run - also delete the public originals after a verified copy:
 *   npx ts-node scripts/migrate-private-media.ts --delete-source
 *
 * Required env (same as the app): MONGODB_URI, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *   R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME (public source), R2_PRIVATE_BUCKET_NAME
 *   (private target), R2_PUBLIC_URL (the public base legacy refs were built from).
 *
 * This script is R2-only (production storage). It does NOT run automatically; the
 * owner runs it once, after creating the private bucket. Do a --dry-run first.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import {
  S3Client,
  CopyObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { decidePrivateMediaMigration } from '../src/modules/uploads/private-media.migration';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_SOURCE = process.argv.includes('--delete-source');

const publicBaseUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const publicBucket = process.env.R2_BUCKET_NAME || '';
const privateBucket = process.env.R2_PRIVATE_BUCKET_NAME || '';
const accountId = process.env.R2_ACCOUNT_ID || '';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

interface Stats {
  scanned: number;
  migrated: number;
  skippedAlreadyPrivate: number;
  skippedEmpty: number;
  skippedForeign: number;
  copyVerifyFailures: number;
  deletedSource: number;
}
const stats: Stats = {
  scanned: 0,
  migrated: 0,
  skippedAlreadyPrivate: 0,
  skippedEmpty: 0,
  skippedForeign: 0,
  copyVerifyFailures: 0,
  deletedSource: 0,
};

async function objectSize(bucket: string, key: string): Promise<number | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch {
    return null;
  }
}

/**
 * Resolve ONE stored value to its post-migration ref, performing the copy + verify
 * (and optional source delete) as a side effect. Returns the new canonical ref
 * when the value migrated, or null when it was skipped / unchanged.
 */
async function migrateValue(value: string | null | undefined): Promise<string | null> {
  stats.scanned += 1;
  const decision = decidePrivateMediaMigration(value, { publicBaseUrl });
  switch (decision.action) {
    case 'skip-empty':
      stats.skippedEmpty += 1;
      return null;
    case 'skip-already-private':
      stats.skippedAlreadyPrivate += 1;
      return null;
    case 'skip-foreign':
      stats.skippedForeign += 1;
      return null;
    case 'migrate':
      break;
  }

  const key = decision.objectKey;
  if (DRY_RUN) {
    console.log(`  WOULD migrate ${key} -> ${decision.newRef}`);
    stats.migrated += 1;
    return decision.newRef;
  }

  // Copy public -> private, then verify by size before trusting the move.
  await s3.send(
    new CopyObjectCommand({
      Bucket: privateBucket,
      Key: key,
      CopySource: `/${publicBucket}/${key}`,
    }),
  );
  const [srcSize, dstSize] = await Promise.all([
    objectSize(publicBucket, key),
    objectSize(privateBucket, key),
  ]);
  if (srcSize === null || dstSize === null || srcSize !== dstSize) {
    stats.copyVerifyFailures += 1;
    console.error(
      `  COPY VERIFY FAILED for ${key} (src=${srcSize} dst=${dstSize}) - skipping DB rewrite`,
    );
    return null;
  }

  if (DELETE_SOURCE) {
    await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: key }));
    stats.deletedSource += 1;
  }

  stats.migrated += 1;
  return decision.newRef;
}

async function migrate() {
  const uri =
    process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/zari360';
  console.log('Connecting to:', uri.replace(/\/\/.*@/, '//***@'));
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}; delete-source: ${DELETE_SOURCE}`);
  if (!DRY_RUN && (!privateBucket || !publicBucket || !publicBaseUrl)) {
    throw new Error('Missing R2_BUCKET_NAME / R2_PRIVATE_BUCKET_NAME / R2_PUBLIC_URL');
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  // ── connect_messages: media[].url + audioUrl ─────────────────────────────
  console.log('\nMessages (inbox media + voice)...');
  const messages = db.collection('connect_messages');
  const msgCursor = messages.find({
    $or: [{ 'media.0': { $exists: true } }, { audioUrl: { $ne: null } }],
  });
  for await (const m of msgCursor) {
    let changed = false;
    const media = Array.isArray(m.media) ? m.media : [];
    for (const item of media) {
      const next = await migrateValue(item?.url);
      if (next) {
        item.url = next;
        changed = true;
      }
    }
    const nextAudio = await migrateValue(m.audioUrl);
    const audioUrl = nextAudio ?? m.audioUrl;
    if (nextAudio) changed = true;
    if (changed && !DRY_RUN) {
      await messages.updateOne({ _id: m._id }, { $set: { media, audioUrl } });
    }
  }

  // ── connect_job_applications: voiceNoteUrl + resumeUrl ───────────────────
  console.log('\nJob applications (voice + resume)...');
  const apps = db.collection('connect_job_applications');
  const appCursor = apps.find({
    $or: [{ voiceNoteUrl: { $ne: null } }, { resumeUrl: { $ne: null } }],
  });
  for await (const a of appCursor) {
    const nextVoice = await migrateValue(a.voiceNoteUrl);
    const nextResume = await migrateValue(a.resumeUrl);
    const set: Record<string, unknown> = {};
    if (nextVoice) set.voiceNoteUrl = nextVoice;
    if (nextResume) set.resumeUrl = nextResume;
    if (Object.keys(set).length > 0 && !DRY_RUN) {
      await apps.updateOne({ _id: a._id }, { $set: set });
    }
  }

  // ── upload_events: fileUrl (ownership log) for the private categories ─────
  // The ownership records keep the canonical ref so delete + ownership checks
  // keep working after the object moves. Only rows in the now-private categories.
  console.log('\nUpload events (ownership log)...');
  const events = db.collection('uploadevents');
  const PRIVATE_CATEGORIES = ['connect-inbox-media', 'connect-job-resume', 'connect-job-voice'];
  const evCursor = events.find({ category: { $in: PRIVATE_CATEGORIES } });
  for await (const e of evCursor) {
    const next = await migrateValue(e.fileUrl);
    if (next && !DRY_RUN) {
      await events.updateOne({ _id: e._id }, { $set: { fileUrl: next } });
    }
  }

  await mongoose.disconnect();
  console.log('\nMigration complete. Stats:', JSON.stringify(stats, null, 2));
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
