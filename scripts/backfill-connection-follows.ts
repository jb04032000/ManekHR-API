/**
 * backfill:connect-follows — one-shot migration for Zari360 Connect.
 *
 * WHY: "Connect implies a mutual follow" was wired only in Phase 7a, and the
 * feed fans out to FOLLOWERS. Any `Connection` formed BEFORE that wiring has no
 * `Follow` edges, so the two connected members never see each other's posts.
 * This backfill makes the graph consistent:
 *   for every existing Connection {userA, userB}
 *     1. ensure BOTH follow edges (A→B and B→A) exist — idempotent upsert;
 *     2. backfill each peer's recent posts into the other's FeedEntry feed
 *        (so posts made before the follow edge existed show up now).
 *
 * Idempotent + safe to re-run: follow upserts and FeedEntry upserts are no-ops
 * when the rows already exist (the unique indexes are the backstop). Pass
 * `--dry-run` to print what it WOULD do without writing.
 *
 *   Run:  pnpm exec ts-node -r tsconfig-paths/register scripts/backfill-connection-follows.ts [--dry-run]
 *         (backend worktree; mirrors `scripts/seed-connect.ts`)
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose, { Types } from 'mongoose';
import { ConnectionSchema } from '../src/modules/connect/network/schemas/connection.schema';
import { FollowSchema } from '../src/modules/connect/network/schemas/follow.schema';
import { PostSchema } from '../src/modules/connect/feed/schemas/post.schema';
import { FeedEntrySchema } from '../src/modules/connect/feed/schemas/feed-entry.schema';
import { BACKFILL_LIMIT } from '../src/modules/connect/feed/feed.constants';

/** Load `.env` into `process.env` (ambient vars win) — mirrors seed-connect. */
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
    // No `.env` — fall back to the ambient environment.
  }
}

loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');

interface ConnectionRow {
  userA: Types.ObjectId;
  userB: Types.ObjectId;
}
interface PostRow {
  _id: Types.ObjectId;
  createdAt: Date;
}

async function run(): Promise<void> {
  const uri =
    process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/zari360';
  console.log(
    `[backfill:connect-follows]${DRY_RUN ? ' (DRY RUN)' : ''} Connecting to`,
    uri.replace(/\/\/.*@/, '//***@'),
  );
  await mongoose.connect(uri);

  const ConnectionModel = mongoose.model('Connection', ConnectionSchema);
  const FollowModel = mongoose.model('Follow', FollowSchema);
  const PostModel = mongoose.model('Post', PostSchema);
  const FeedEntryModel = mongoose.model('FeedEntry', FeedEntrySchema);

  const connections = await ConnectionModel.find().lean<ConnectionRow[]>().exec();
  console.log(`[backfill:connect-follows] ${connections.length} connection(s) to process.`);

  let followsCreated = 0;
  let feedEntriesWritten = 0;
  let processed = 0;

  /** Ensure one directional follow edge; returns 1 if it was missing. */
  async function ensureFollow(follower: Types.ObjectId, followee: Types.ObjectId): Promise<number> {
    const filter = { followerId: follower, followeeType: 'user' as const, followeeId: followee };
    const existing = await FollowModel.exists(filter);
    if (existing) return 0;
    if (!DRY_RUN) await FollowModel.updateOne(filter, { $setOnInsert: filter }, { upsert: true });
    return 1;
  }

  /** Backfill `author`'s recent posts into `owner`'s feed; returns rows written. */
  async function backfillFeed(owner: Types.ObjectId, author: Types.ObjectId): Promise<number> {
    const posts = await PostModel.find({ authorId: author, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(BACKFILL_LIMIT)
      .select('_id createdAt')
      .lean<PostRow[]>()
      .exec();
    if (posts.length === 0) return 0;
    if (DRY_RUN) return posts.length;
    const ops = posts.map((p) => ({
      updateOne: {
        filter: { ownerId: owner, postId: p._id },
        update: { $setOnInsert: { authorId: author, postedAt: p.createdAt } },
        upsert: true,
      },
    }));
    const res = await FeedEntryModel.bulkWrite(ops, { ordered: false });
    return res.upsertedCount ?? 0;
  }

  for (const conn of connections) {
    const a = new Types.ObjectId(conn.userA);
    const b = new Types.ObjectId(conn.userB);
    followsCreated += await ensureFollow(a, b);
    followsCreated += await ensureFollow(b, a);
    feedEntriesWritten += await backfillFeed(a, b);
    feedEntriesWritten += await backfillFeed(b, a);
    if (++processed % 500 === 0) {
      console.log(`[backfill:connect-follows] …${processed}/${connections.length} processed`);
    }
  }

  console.log(
    `\n[backfill:connect-follows]${DRY_RUN ? ' (DRY RUN — nothing written)' : ''} Done.\n` +
      `  connections processed : ${processed}\n` +
      `  follow edges ${DRY_RUN ? 'missing' : 'created'} : ${followsCreated}\n` +
      `  feed entries ${DRY_RUN ? 'to backfill' : 'written'} : ${feedEntriesWritten}`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[backfill:connect-follows] Error:', err);
  process.exit(1);
});
