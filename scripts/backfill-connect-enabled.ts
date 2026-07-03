/**
 * One-off backfill — set `connectEnabled: true` on every existing User that is
 * not already `true`.
 *
 * Run ONCE, now, as part of Connect-first Wave 0. The old schema default was
 * `false`, so existing users have `connectEnabled: false` stored explicitly
 * (the field exists with value `false`, it is not missing) — `{ $ne: true }`
 * is what catches them; `{ $exists: false }` would miss them. The admin
 * kill-switch (deliberately setting a user back to `false`) does not exist
 * yet, so right now every stored `false` is the old default. Do NOT re-run
 * this script once the kill-switch is in use — it would clobber a
 * deliberately-disabled user.
 *
 * Connects to Mongo directly (mirrors `scripts/seed-connect.ts`) rather than
 * booting the full Nest app — keeps the import graph tiny so `ts-node` does
 * not type-check unrelated modules.
 *
 * Run: pnpm run backfill:connect-enabled
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { UserSchema } from '../src/modules/users/schemas/user.schema';

/**
 * Load `.env` (`KEY=VALUE` lines) into `process.env` — a zero-dependency
 * reader so the script needs no `dotenv` package. Ambient env vars win.
 * Mirrors `scripts/seed-connect.ts`.
 */
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
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted) value = value.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No `.env` file — fall back to the ambient environment.
  }
}

loadEnv();

async function run(): Promise<void> {
  const uri =
    process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/zari360';

  console.log('[backfill-connect-enabled] Connecting to', uri.replace(/\/\/.*@/, '//***@'));
  await mongoose.connect(uri);

  try {
    const UserModel = mongoose.model('User', UserSchema);
    const res = await UserModel.updateMany(
      { connectEnabled: { $ne: true } },
      { $set: { connectEnabled: true } },
    );
    console.log(`[backfill-connect-enabled] updated ${res.modifiedCount} user(s)`);
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('[backfill-connect-enabled] failed:', err);
  process.exit(1);
});
