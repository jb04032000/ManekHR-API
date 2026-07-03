/**
 * Backup/restore DRILL (launch DR — Workstream F). PROVES backups restore.
 *
 *   npm run backup:verify
 *
 * Against MONGODB_URI, using TWO throwaway scratch databases (never touches real
 * data): seeds synthetic documents with varied BSON types into a `src` scratch db
 * -> backs it up -> restores into a `dst` scratch db -> verifies counts + type
 * fidelity (ObjectId / Date / Decimal128 / nested) -> drops both scratch dbs.
 * Prints PASS/FAIL and the elapsed restore time (an RTO proxy). Exit 0 = PASS.
 *
 * This is the operational "tested restore" the owner runs on the real Mongo
 * deployment to confirm the backup tooling works end-to-end there. The automated
 * regression version lives in src/common/backup/__tests__/backup-restore.vitest.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MongoClient, ObjectId, Decimal128 } from 'mongodb';
import { backupDatabase } from '../src/common/backup/mongo-backup';
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

async function main(): Promise<void> {
  loadEnv();
  const log = (m: string) => console.log(`[drill] ${m}`);
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/zari360';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const srcDb = `cr_backup_drill_src_${stamp}`;
  const dstDb = `cr_backup_drill_dst_${stamp}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-backup-drill-'));

  const client = new MongoClient(uri);
  let pass = true;
  try {
    await client.connect();
    log(`scratch dbs: ${srcDb} (source) / ${dstDb} (restore target)`);

    // 1. Seed synthetic data with varied BSON types into the src scratch db.
    const oid = new ObjectId();
    const when = new Date('2026-06-15T10:00:00.000Z');
    const src = client.db(srcDb);
    await src.collection('salaries').insertMany([
      {
        _id: oid,
        amount: Decimal128.fromString('12345.67'),
        month: 6,
        year: 2026,
        nested: { at: when, tags: ['a', 'b'] },
      },
      { amount: Decimal128.fromString('0.00'), month: 5, year: 2026 },
    ]);
    await src.collection('attendances').insertMany([
      { at: when, status: 'present' },
      { at: when, status: 'absent' },
    ]);
    log('seeded synthetic source data (salaries x2, attendances x2)');

    // 2. Backup the src scratch db.
    const manifest = await backupDatabase({
      uri,
      dbName: srcDb,
      outDir: workDir,
      gzip: true,
      logger: log,
    });

    // 3. Restore into the dst scratch db, timing it (RTO proxy).
    const t0 = Date.now();
    await restoreDatabase({ uri, dbName: dstDb, inDir: manifest.dir, drop: true, logger: log });
    const restoreMs = Date.now() - t0;

    // 4. Verify counts + type fidelity in the restored db.
    const dst = client.db(dstDb);
    const salCount = await dst.collection('salaries').countDocuments();
    const attCount = await dst.collection('attendances').countDocuments();
    const restored = await dst
      .collection('salaries')
      .findOne<{ _id: ObjectId; amount: Decimal128; nested: { at: Date } }>({ _id: oid });

    const checks: Array<[string, boolean]> = [
      ['salaries count == 2', salCount === 2],
      ['attendances count == 2', attCount === 2],
      ['ObjectId _id preserved', !!restored && restored._id.equals(oid)],
      [
        'Decimal128 amount preserved',
        !!restored &&
          restored.amount instanceof Decimal128 &&
          restored.amount.toString() === '12345.67',
      ],
      [
        'Date preserved',
        !!restored &&
          restored.nested?.at instanceof Date &&
          restored.nested.at.getTime() === when.getTime(),
      ],
    ];
    for (const [label, ok] of checks) {
      log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) pass = false;
    }
    log(`restore time (RTO proxy for this dataset): ${restoreMs}ms`);
  } finally {
    // 5. Always clean up scratch dbs + temp files.
    await client
      .db(srcDb)
      .dropDatabase()
      .catch(() => undefined);
    await client
      .db(dstDb)
      .dropDatabase()
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (pass) {
    log('RESULT: PASS — backups restore correctly with full type fidelity.');
    process.exit(0);
  } else {
    log(
      'RESULT: FAIL — restore did not reproduce the source. Investigate before relying on backups.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[drill] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
