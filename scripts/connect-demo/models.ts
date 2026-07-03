/**
 * connect-demo/models.ts — shared Mongoose wiring for the demo seed and the
 * auto-poster. Registers every schema the demo touches (idempotently, so both
 * scripts can import it) and exposes a typed bag of models plus small env/db
 * helpers.
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose, { Schema, Model } from 'mongoose';

import { UserSchema } from '../../src/modules/users/schemas/user.schema';
import { WorkspaceSchema } from '../../src/modules/workspaces/schemas/workspace.schema';
import { WorkspaceMemberSchema } from '../../src/modules/workspaces/schemas/workspace-member.schema';
import { AttendanceSchema } from '../../src/modules/attendance/schemas/attendance.schema';
import { ConnectProfileSchema } from '../../src/modules/connect/profile/schemas/connect-profile.schema';
import { ConnectionSchema } from '../../src/modules/connect/network/schemas/connection.schema';
import { ConnectionRequestSchema } from '../../src/modules/connect/network/schemas/connection-request.schema';
import { FollowSchema } from '../../src/modules/connect/network/schemas/follow.schema';
import { PostSchema } from '../../src/modules/connect/feed/schemas/post.schema';
import { ReactionSchema } from '../../src/modules/connect/feed/schemas/reaction.schema';
import { CommentSchema } from '../../src/modules/connect/feed/schemas/comment.schema';
import { FeedEntrySchema } from '../../src/modules/connect/feed/schemas/feed-entry.schema';
import { CompanyPageSchema } from '../../src/modules/connect/entities/schemas/company-page.schema';
import { StorefrontSchema } from '../../src/modules/connect/entities/schemas/storefront.schema';
import { ListingSchema } from '../../src/modules/connect/marketplace/schemas/listing.schema';
import { RfqSchema } from '../../src/modules/connect/rfq/schemas/rfq.schema';
import { QuoteSchema } from '../../src/modules/connect/rfq/schemas/quote.schema';
import { JobSchema } from '../../src/modules/connect/jobs/schemas/job.schema';
import { JobApplicationSchema } from '../../src/modules/connect/jobs/schemas/job-application.schema';
import { ThreadSchema } from '../../src/modules/connect/inbox/schemas/thread.schema';
import { MessageSchema } from '../../src/modules/connect/inbox/schemas/message.schema';
import { InquirySchema } from '../../src/modules/connect/marketplace/schemas/inquiry.schema';

/** Demo accounts are tagged by this fake email domain — used for cleanup. */
export const DEMO_DOMAIN = '@connect-demo.zari360.test';

/**
 * Load `.env` (`KEY=VALUE`) into `process.env` — zero-dependency so neither
 * script needs `dotenv`. Ambient env vars win.
 */
export function loadEnv(): void {
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
    /* no .env — use ambient env */
  }
}

export function mongoUri(): string {
  return process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/zari360';
}

export async function connectMongo(): Promise<string> {
  const uri = mongoUri();
  await mongoose.connect(uri);
  return uri.replace(/\/\/.*@/, '//***@');
}

/**
 * Register a model once (safe to call from multiple importers).
 *
 * The two branches infer different Document types, which would otherwise widen
 * to an un-callable union (`Model<A> | Model<B>`); we collapse to a single
 * permissive `Model` type so `.create()` / `.updateOne()` stay callable — the
 * seed builds documents dynamically, so per-field typing isn't needed here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model(name: string, schema: Schema): Model<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mongoose.models[name] ?? mongoose.model(name, schema)) as Model<any>;
}

export type DemoModels = ReturnType<typeof getModels>;

export function getModels() {
  return {
    User: model('User', UserSchema),
    Workspace: model('Workspace', WorkspaceSchema),
    WorkspaceMember: model('WorkspaceMember', WorkspaceMemberSchema),
    Attendance: model('Attendance', AttendanceSchema),
    ConnectProfile: model('ConnectProfile', ConnectProfileSchema),
    Connection: model('Connection', ConnectionSchema),
    ConnectionRequest: model('ConnectionRequest', ConnectionRequestSchema),
    Follow: model('Follow', FollowSchema),
    Post: model('Post', PostSchema),
    Reaction: model('Reaction', ReactionSchema),
    Comment: model('Comment', CommentSchema),
    FeedEntry: model('FeedEntry', FeedEntrySchema),
    CompanyPage: model('CompanyPage', CompanyPageSchema),
    Storefront: model('Storefront', StorefrontSchema),
    Listing: model('Listing', ListingSchema),
    Rfq: model('Rfq', RfqSchema),
    Quote: model('Quote', QuoteSchema),
    Job: model('Job', JobSchema),
    JobApplication: model('JobApplication', JobApplicationSchema),
    Thread: model('Thread', ThreadSchema),
    Message: model('Message', MessageSchema),
    Inquiry: model('Inquiry', InquirySchema),
  };
}

/**
 * Delete every demo row (matched by the demo email domain) across all Connect
 * collections. Shared by the seed (before re-seeding) and any teardown.
 * Returns the number of demo users removed.
 */
export async function purgeDemo(m: DemoModels): Promise<number> {
  const prior = await m.User.find({
    $or: [{ isDemo: true }, { email: { $regex: `${DEMO_DOMAIN.replace('.', '\\.')}$` } }],
  })
    .select('_id')
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
  if (prior.length === 0) return 0;
  const ids = prior.map((u) => u._id);

  const ws = await m.Workspace.find({ ownerId: { $in: ids } })
    .select('_id')
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
  const wsIds = ws.map((w) => w._id);

  await m.Attendance.deleteMany({ workspaceId: { $in: wsIds } });
  await m.WorkspaceMember.deleteMany({ workspaceId: { $in: wsIds } });
  await m.Workspace.deleteMany({ _id: { $in: wsIds } });
  await m.ConnectProfile.deleteMany({ userId: { $in: ids } });
  await m.Connection.deleteMany({ $or: [{ userA: { $in: ids } }, { userB: { $in: ids } }] });
  await m.ConnectionRequest.deleteMany({
    $or: [{ fromUserId: { $in: ids } }, { toUserId: { $in: ids } }],
  });
  await m.Follow.deleteMany({ $or: [{ followerId: { $in: ids } }, { followeeId: { $in: ids } }] });
  await m.FeedEntry.deleteMany({ ownerId: { $in: ids } });
  await m.Reaction.deleteMany({ userId: { $in: ids } });
  await m.Comment.deleteMany({ authorId: { $in: ids } });
  await m.Post.deleteMany({ authorId: { $in: ids } });
  await m.Listing.deleteMany({ ownerUserId: { $in: ids } });
  await m.Storefront.deleteMany({ ownerUserId: { $in: ids } });
  await m.CompanyPage.deleteMany({ ownerUserId: { $in: ids } });
  await m.Quote.deleteMany({ sellerUserId: { $in: ids } });
  await m.Rfq.deleteMany({ buyerUserId: { $in: ids } });
  await m.JobApplication.deleteMany({ applicantUserId: { $in: ids } });
  await m.Job.deleteMany({ companyUserId: { $in: ids } });

  const threads = await m.Thread.find({ participantIds: { $in: ids } })
    .select('_id')
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
  const threadIds = threads.map((t) => t._id);
  await m.Message.deleteMany({ threadId: { $in: threadIds } });
  await m.Thread.deleteMany({ _id: { $in: threadIds } });
  await m.Inquiry.deleteMany({
    $or: [{ buyerUserId: { $in: ids } }, { sellerUserId: { $in: ids } }],
  });
  await m.User.deleteMany({ _id: { $in: ids } });
  return ids.length;
}
