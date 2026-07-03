/**
 * set:demo-passwords — set a password on DEMO accounts only.
 *
 * Lets you sign in as any demo persona with mobile/email + password (no OTP).
 * Scope is hard-locked to the demo cast: it matches ONLY users that are BOTH
 * `isDemo: true` AND carry the `@connect-demo.zari360.test` email domain, so a
 * real user can never be touched. Idempotent — safe to re-run.
 *
 *   Run:  npm run set:demo-passwords
 */
import * as bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import { loadEnv, connectMongo, getModels, DEMO_DOMAIN } from './connect-demo/models';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@1234';

async function run(): Promise<void> {
  loadEnv();
  const where = await connectMongo();
  console.log(`[set:demo-passwords] Connected: ${where}`);

  const m = getModels();

  // Demo-only guard: require BOTH the isDemo flag AND the demo email domain.
  const demoFilter = {
    isDemo: true,
    email: { $regex: `${DEMO_DOMAIN.replace(/\./g, '\\.')}$`, $options: 'i' },
  };

  const count = await m.User.countDocuments(demoFilter);
  if (count === 0) {
    console.log('[set:demo-passwords] No demo accounts found — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 12);
  const res = await m.User.updateMany(demoFilter, { $set: { passwordHash } });

  console.log(
    `[set:demo-passwords] Set password "${DEMO_PASSWORD}" on ${res.modifiedCount}/${count} demo account(s).`,
  );
  console.log('  Sign in with the mobile number or email + this password (no OTP).');
  await mongoose.disconnect();
  console.log('[set:demo-passwords] Done.');
}

run().catch((err) => {
  console.error('[set:demo-passwords] Error:', err);
  process.exit(1);
});
