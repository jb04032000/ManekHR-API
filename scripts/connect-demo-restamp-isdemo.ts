/**
 * connect:demo:restamp — stamp `isDemo:true` on existing demo-owned Connect
 * content (posts / listings / jobs / job applications / rfqs / quotes).
 *
 * WHY: the denormalized `isDemo` flag is what the FE "Sample" badge + the
 * feed/search demo down-rank read. Content created before the create-time stamp
 * was added (seed / auto-post / admin "post as") was written with the schema
 * default `isDemo:false`, so it renders with NO badge. Migration 0048 is
 * `kind:'once'` and won't re-run for newer content, so this re-stamps in place.
 *
 * Idempotent: the `isDemo:{ $ne:true }` guard makes a re-run a no-op. Only demo
 * accounts (`users.isDemo===true` OR the demo email suffix) are matched, so real
 * users are never touched. Mirrors BackfillConnectContentIsDemoService (mig 0048).
 *
 *   Run:  npm run connect:demo:restamp
 */
import mongoose, { Types } from 'mongoose';
import { loadEnv, connectMongo, getModels, DEMO_DOMAIN } from './connect-demo/models';

async function main(): Promise<void> {
  loadEnv();
  const masked = await connectMongo();
  console.log('[connect:demo:restamp] Connected to', masked);
  const m = getModels();

  const users = await m.User.find({
    $or: [{ isDemo: true }, { email: { $regex: `${DEMO_DOMAIN.replace('.', '\\.')}$` } }],
  })
    .select('_id')
    .lean<Array<{ _id: Types.ObjectId }>>();
  const ids = users.map((u) => u._id);

  if (ids.length === 0) {
    console.log('\nNo demo accounts found — nothing to stamp.\n');
    await mongoose.disconnect();
    return;
  }
  console.log(`\nFound ${ids.length} demo account(s). Stamping isDemo:true on their content...\n`);

  // [collection model, owner field] — matches migration 0048's mapping.
  const targets: Array<[keyof ReturnType<typeof getModels>, string]> = [
    ['Post', 'authorId'],
    ['Listing', 'ownerUserId'],
    ['Job', 'companyUserId'],
    ['JobApplication', 'applicantUserId'],
    ['Rfq', 'buyerUserId'],
    ['Quote', 'sellerUserId'],
  ];

  for (const [modelKey, ownerField] of targets) {
    const Model = m[modelKey] as mongoose.Model<unknown>;
    const res = await Model.updateMany(
      { [ownerField]: { $in: ids }, isDemo: { $ne: true } },
      { $set: { isDemo: true } },
    );
    console.log(`  ${String(modelKey).padEnd(16)} stamped ${res.modifiedCount ?? 0}`);
  }

  await mongoose.disconnect();
  console.log('\n[connect:demo:restamp] Done.');
}

main().catch((err) => {
  console.error('[connect:demo:restamp] Error:', err);
  process.exit(1);
});
