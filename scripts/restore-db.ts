/**
 * MongoDB restore CLI (launch DR — Workstream F).
 *
 *   npm run backup:restore -- --dir ./backups/backup-<iso> --drop
 *   npm run backup:restore -- --dir <dir> --uri <targetUri> --collections salaries,attendances
 *
 * Restores a logical backup (produced by `npm run backup`) into a target DB.
 * SAFETY: into a NON-EMPTY target it refuses unless --drop (clean each target
 * collection first) or --force (insert alongside). Restore to a SCRATCH/staging
 * cluster for drills; only restore to prod during an actual recovery.
 *
 * Flags:
 *   --dir <path>          backup directory containing manifest.json (required)
 *   --uri <uri>           target connection (default MONGODB_URI)
 *   --db <name>           override target database name
 *   --collections a,b     restrict to these collections
 *   --drop                drop each target collection before inserting
 *   --force               insert alongside existing data
 */
import * as fs from 'fs';
import * as path from 'path';
import { restoreDatabase } from '../src/common/backup/mongo-restore';

function loadEnv(): void {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let value = t.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // ambient env
  }
}

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  loadEnv();
  const log = (m: string) => console.log(`[restore] ${m}`);
  const dir = getFlag('dir');
  if (!dir) {
    console.error(
      '[restore] usage: npm run backup:restore -- --dir <backupDir> [--drop|--force] ' +
        '[--uri <uri>] [--db <name>] [--collections a,b]',
    );
    process.exit(1);
  }
  const uri = getFlag('uri') || process.env.MONGODB_URI || 'mongodb://localhost:27017/zari360';
  const collectionsArg = getFlag('collections');
  const report = await restoreDatabase({
    uri,
    inDir: dir,
    drop: hasFlag('drop'),
    force: hasFlag('force'),
    dbName: getFlag('db'),
    collections: collectionsArg ? collectionsArg.split(',').map((s) => s.trim()) : undefined,
    logger: log,
  });
  const total = report.collections.reduce((s, c) => s + c.count, 0);
  log(`restored ${report.collections.length} collections (${total} docs) into db "${report.db}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[restore] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
