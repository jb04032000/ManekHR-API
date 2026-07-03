/**
 * Daily MongoDB backup CLI (launch DR — Workstream F).
 *
 *   npm run backup
 *
 * Dumps every collection of MONGODB_URI to a timestamped, gzipped, type-faithful
 * logical backup under BACKUP_DIR, optionally uploads it off-box to S3/R2, then
 * prunes local backups older than BACKUP_RETENTION_DAYS. Fail-closed: any error
 * exits non-zero so a cron / CI step / monitor notices a failed backup (silent
 * backup failure is the #1 reason "backups" turn out not to exist).
 *
 * Schedule it once a day on the host (cron / Task Scheduler / a GitHub Actions
 * scheduled workflow). Env:
 *   MONGODB_URI            source database (required in prod)
 *   BACKUP_DIR             local output root (default ./backups)
 *   BACKUP_RETENTION_DAYS  local retention window (default 30)
 *   BACKUP_GZIP            'false' to disable gzip (default on)
 *   BACKUP_BUCKET          S3/R2 bucket for off-box upload (skipped if unset)
 *   BACKUP_ENDPOINT        S3-compatible endpoint (R2); omit for AWS S3
 *   BACKUP_ACCESS_KEY / BACKUP_SECRET_KEY  upload credentials
 *   BACKUP_KEY_PREFIX      object key prefix (default mongo-backups)
 *
 * See docs/deployment/BACKUP-AND-RESTORE.md for the full runbook + the
 * mongodump / Atlas alternatives for larger datasets / point-in-time recovery.
 */
import * as fs from 'fs';
import * as path from 'path';
import { backupDatabase, pruneBackups } from '../src/common/backup/mongo-backup';
import { uploadBackupDir } from '../src/common/backup/s3-upload';

// Zero-dependency .env reader (ambient env wins). Mirrors scripts/seed-connect.ts.
function loadEnv(): void {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no .env file — rely on ambient env (the prod path)
  }
}

async function main(): Promise<void> {
  loadEnv();
  const log = (m: string) => console.log(`[backup] ${m}`);
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/zari360';
  const outDir = process.env.BACKUP_DIR || './backups';
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  const gzip = process.env.BACKUP_GZIP !== 'false';

  const started = Date.now();
  const manifest = await backupDatabase({ uri, outDir, gzip, logger: log });
  const totalDocs = manifest.collections.reduce((s, c) => s + c.count, 0);
  log(`dumped ${manifest.collections.length} collections (${totalDocs} docs) -> ${manifest.dir}`);

  if (process.env.BACKUP_BUCKET) {
    const res = await uploadBackupDir(
      manifest.dir,
      {
        bucket: process.env.BACKUP_BUCKET,
        endpoint: process.env.BACKUP_ENDPOINT || undefined,
        accessKeyId: process.env.BACKUP_ACCESS_KEY || '',
        secretAccessKey: process.env.BACKUP_SECRET_KEY || '',
        keyPrefix: process.env.BACKUP_KEY_PREFIX || 'mongo-backups',
      },
      log,
    );
    log(`off-box upload complete: ${res.uploaded.length} objects -> ${res.bucket}`);
  } else {
    log('BACKUP_BUCKET unset — LOCAL backup only (set it for off-box upload).');
  }

  const removed = pruneBackups(outDir, retentionDays);
  if (removed.length) log(`pruned ${removed.length} local backup(s) older than ${retentionDays}d`);

  log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[backup] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1); // fail-closed
});
