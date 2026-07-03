/**
 * connect:demo:clear — remove ALL Connect demo content.
 *
 * Deletes every @connect-demo.zari360.test account and everything they own
 * (profiles, posts, feed rows, listings, jobs, RFQs, pages, storefronts, inbox
 * threads, etc.). Real user data is never touched. This is the clean exit for
 * when the platform has enough genuine activity to stand on its own.
 *
 *   Run:  npm run connect:demo:clear
 */
import mongoose from 'mongoose';
import { loadEnv, connectMongo, getModels, purgeDemo } from './connect-demo/models';

async function main(): Promise<void> {
  loadEnv();
  const masked = await connectMongo();
  console.log('[connect:demo:clear] Connected to', masked);
  const removed = await purgeDemo(getModels());
  console.log(
    `[connect:demo:clear] Removed ${removed} demo account(s) and all their Connect content.`,
  );
  await mongoose.disconnect();
  console.log('[connect:demo:clear] Done.');
}

main().catch((err) => {
  console.error('[connect:demo:clear] Error:', err);
  process.exit(1);
});
