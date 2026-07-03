/* One-time ops migration (owner-run, NOT CI): enforce one storefront per company
   page BEFORE the partial unique index in storefront.schema.ts can build. For any
   companyPageId with >1 linked storefront, keep the most-recently-updated and set
   the others' companyPageId to null (unlink, never delete). Idempotent: a second
   run finds no dupes and unlinks nothing.

   Links to: storefront.schema.ts (the partial unique index this protects) and
   StorefrontService.attachStorefrontToPage (the runtime one-store-per-page guard).
   Gotcha: run this against EACH environment before deploying the unique index, or
   the index build fails on pre-existing duplicates.

   Run: npx ts-node -r tsconfig-paths/register \
        src/scripts/migrations/2026-06-07-dedupe-page-storefronts.ts */
import { connect, connection, Types } from 'mongoose';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await connect(uri);
  const col = connection.collection('connect_storefronts');
  // Group linked storefronts by page, newest first, keeping only pages with >1.
  const dupes = await col
    .aggregate<{
      _id: Types.ObjectId;
      ids: Types.ObjectId[];
    }>([
      { $match: { companyPageId: { $ne: null } } },
      { $sort: { updatedAt: -1 } },
      { $group: { _id: '$companyPageId', ids: { $push: '$_id' } } },
      { $match: { 'ids.1': { $exists: true } } },
    ])
    .toArray();
  let unlinked = 0;
  for (const d of dupes) {
    const [, ...rest] = d.ids; // keep first (newest updated), unlink the rest
    if (rest.length) {
      await col.updateMany({ _id: { $in: rest } }, { $set: { companyPageId: null } });
      unlinked += rest.length;
    }
  }
  console.log(`de-dup complete: ${dupes.length} pages, ${unlinked} storefronts unlinked`);
  await connection.close();
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
