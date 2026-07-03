/**
 * connect:demo:list — show every Connect demo account with its login and a
 * count of what it owns. Handy before a bulk clear, or to grab a login so you
 * can sign in as a demo persona and post manually.
 *
 * Demo accounts sign in with their mobile number + the dev mock OTP (123456).
 *
 *   Run:  npm run connect:demo:list
 */
import mongoose, { Types } from 'mongoose';
import { loadEnv, connectMongo, getModels, DEMO_DOMAIN } from './connect-demo/models';

async function main(): Promise<void> {
  loadEnv();
  const masked = await connectMongo();
  console.log('[connect:demo:list] Connected to', masked);
  const m = getModels();

  const users = await m.User.find({
    $or: [{ isDemo: true }, { email: { $regex: `${DEMO_DOMAIN.replace('.', '\\.')}$` } }],
  })
    .select('_id name mobile handle')
    .sort({ mobile: 1 })
    .lean<Array<{ _id: Types.ObjectId; name: string; mobile: string; handle: string }>>();

  if (users.length === 0) {
    console.log('\nNo demo accounts found. Run `npm run seed:connect` to create them.\n');
    await mongoose.disconnect();
    return;
  }

  console.log(
    `\n${users.length} demo accounts — sign in with the mobile number + dev OTP 123456:\n`,
  );
  console.log(
    '  NAME                  MOBILE        PROFILE                          POSTS  LISTINGS  JOBS',
  );
  console.log('  ' + '-'.repeat(92));
  for (const u of users) {
    const [posts, listings, jobs] = await Promise.all([
      m.Post.countDocuments({ authorId: u._id }),
      m.Listing.countDocuments({ ownerUserId: u._id }),
      m.Job.countDocuments({ companyUserId: u._id }),
    ]);
    const name = (u.name || '').padEnd(20).slice(0, 20);
    const handle = `/u/${u.handle}`.padEnd(32).slice(0, 32);
    console.log(
      `  ${name}  ${u.mobile.padEnd(12)}  ${handle}  ${String(posts).padStart(4)}  ${String(listings).padStart(7)}  ${String(jobs).padStart(4)}`,
    );
  }
  console.log('\n  Remove all demo content:  npm run connect:demo:clear');
  console.log('  Add a fresh demo post:    npm run connect:autopost\n');

  await mongoose.disconnect();
  console.log('[connect:demo:list] Done.');
}

main().catch((err) => {
  console.error('[connect:demo:list] Error:', err);
  process.exit(1);
});
