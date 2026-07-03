/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import 'reflect-metadata';
import mongoose, { type Connection, type Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';

import { PostSchema } from '../src/modules/connect/feed/schemas/post.schema';
import { FeedEntrySchema } from '../src/modules/connect/feed/schemas/feed-entry.schema';
import { ReactionSchema } from '../src/modules/connect/feed/schemas/reaction.schema';
import { CommentSchema } from '../src/modules/connect/feed/schemas/comment.schema';
import { EngagementEdgeSchema } from '../src/modules/connect/feed/schemas/engagement-edge.schema';
import { SeenPostSchema } from '../src/modules/connect/feed/schemas/seen-post.schema';
import { SavedPostSchema } from '../src/modules/connect/feed/schemas/saved-post.schema';
import { FeedNegativeSignalSchema } from '../src/modules/connect/feed/schemas/feed-negative-signal.schema';
import { TrendingPostSchema } from '../src/modules/connect/feed/schemas/trending-post.schema';
import { UserBlockSchema } from '../src/modules/connect/inbox/schemas/user-block.schema';
import { FeedService } from '../src/modules/connect/feed/feed.service';
import { TrendingRefreshService } from '../src/modules/connect/feed/discovery/trending-refresh.service';

/**
 * REAL end-to-end of the hardened feed engine against an in-memory MongoDB (no
 * mocked models — actual queries + indexes). Verifies the changes that touch the
 * database: block enforcement (A1), the new partial-TTL + trending indexes build
 * (A2/B2), root dedup (C2), the read-time visibility gate, and the trending
 * materialization job (B2). The non-DB collaborators (ranker / discovery /
 * network / profile / queue) are light stubs; everything DB-touching is real.
 */
jest.setTimeout(120_000);

describe('Connect feed engine (e2e, real MongoDB)', () => {
  let mongod: MongoMemoryServer;
  let conn: Connection;
  let models: Record<string, Model<any>>;

  // Light stubs for the non-DB collaborators.
  const ranker = { key: 'test', rank: (posts: unknown[]) => posts };
  const discovery = { getCandidates: async () => [], getTrending: async () => [] };
  const profile = {
    getRankingSignals: async () => ({
      skills: [],
      openTo: { work: false, hiring: false, deals: false, customOrders: false },
      district: '',
    }),
  };
  const network = {
    listConnections: async () => [],
    listFollowerIds: async () => [],
    listCompanyPageFollowerIds: async () => [],
  };
  const queue = { add: async () => undefined };
  const noop = { emit: () => undefined };
  const tag = { normalizeHashtags: async (t: string[]) => t, recordUsage: async () => undefined };
  const company = { getRefById: async () => null };
  const notifications = { dispatch: async () => undefined };
  const erp = {};

  function feedService(): FeedService {
    return new FeedService(
      models.Post as any,
      models.FeedEntry as any,
      models.Reaction as any,
      queue as any,
      profile as any,
      erp as any,
      ranker as any,
      discovery as any,
      models.FeedNegativeSignal as any,
      models.EngagementEdge as any,
      models.SeenPost as any,
      models.SavedPost as any,
      notifications as any,
      noop as any,
      models.Comment as any,
      tag as any,
      company as any,
      network as any,
      models.UserBlock as any,
    );
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    conn = mongoose.createConnection(mongod.getUri());
    await conn.asPromise();
    models = {
      Post: conn.model('Post', PostSchema),
      FeedEntry: conn.model('FeedEntry', FeedEntrySchema),
      Reaction: conn.model('Reaction', ReactionSchema),
      Comment: conn.model('Comment', CommentSchema),
      EngagementEdge: conn.model('EngagementEdge', EngagementEdgeSchema),
      SeenPost: conn.model('SeenPost', SeenPostSchema),
      SavedPost: conn.model('SavedPost', SavedPostSchema),
      FeedNegativeSignal: conn.model('FeedNegativeSignal', FeedNegativeSignalSchema),
      TrendingPost: conn.model('TrendingPost', TrendingPostSchema),
      UserBlock: conn.model('UserBlock', UserBlockSchema),
    };
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
    await mongod?.stop();
  });

  afterEach(async () => {
    for (const m of Object.values(models)) await m.deleteMany({});
  });

  /** Seed a post + a feed-entry into the viewer's timeline. */
  async function seedInTimeline(
    viewer: Types.ObjectId,
    over: Record<string, unknown> = {},
  ): Promise<any> {
    const post = await models.Post.create({
      authorId: new Types.ObjectId(),
      kind: 'text',
      body: 'hello',
      visibility: 'public',
      ...over,
    });
    await models.FeedEntry.create({
      ownerId: viewer,
      postId: post._id,
      authorId: post.authorId,
      postedAt: post.createdAt ?? new Date(),
    });
    return post;
  }

  it('the new indexes build on real MongoDB (A2 partial-TTL view + B2 trending score)', async () => {
    await models.EngagementEdge.syncIndexes();
    await models.TrendingPost.syncIndexes();
    const edgeIdx = (await models.EngagementEdge.collection.indexes()).map((i: any) => i.name);
    const trendIdx = (await models.TrendingPost.collection.indexes()).map((i: any) => i.name);
    expect(edgeIdx).toContain('engagement_view_ttl');
    expect(trendIdx).toContain('score_-1');
  });

  it('A1 — a blocked author is dropped from the feed (real query)', async () => {
    const viewer = new Types.ObjectId();
    const blockedAuthor = new Types.ObjectId();
    const ok = await seedInTimeline(viewer);
    await seedInTimeline(viewer, { authorId: blockedAuthor });
    await models.UserBlock.create({ blockerUserId: viewer, blockedUserId: blockedAuthor });

    const page = await feedService().getFeed(viewer, 'following');
    const ids = page.posts.map((p: any) => String(p._id));
    expect(ids).toContain(String(ok._id));
    expect(page.posts.every((p: any) => String(p.authorId) !== String(blockedAuthor))).toBe(true);
  });

  it('F3/B1 — a connections-only post from a non-connection is gated out (real query)', async () => {
    const viewer = new Types.ObjectId();
    await seedInTimeline(viewer, { visibility: 'connections' });
    // network.listConnections stub returns [] -> the author is not a connection.
    const page = await feedService().getFeed(viewer, 'following');
    expect(page.posts).toHaveLength(0);
  });

  it('C2 — a root post and its repost collapse to one in a page (real query)', async () => {
    const viewer = new Types.ObjectId();
    const root = await seedInTimeline(viewer);
    // A repost of that root, also in the viewer's timeline.
    await seedInTimeline(viewer, { repostOf: root._id, body: '' });
    const page = await feedService().getFeed(viewer, 'following');
    expect(page.posts).toHaveLength(1);
  });

  it('B2 — the trending refresh job materializes a score-ordered set (real scan + write)', async () => {
    const hotAuthor = new Types.ObjectId();
    await models.Post.create({
      authorId: hotAuthor,
      kind: 'text',
      body: 'hot',
      visibility: 'public',
      reactionCount: 100,
      commentCount: 20,
    });
    await models.Post.create({
      authorId: new Types.ObjectId(),
      kind: 'text',
      body: 'cold',
      visibility: 'public',
      reactionCount: 0,
    });

    const job = new TrendingRefreshService(models.Post as any, models.TrendingPost as any);
    await job.refresh();

    const set = await models.TrendingPost.find().sort({ score: -1 }).lean();
    expect(set.length).toBe(2);
    expect(String((set[0] as any).authorId)).toBe(String(hotAuthor));
    expect((set[0] as any).score).toBeGreaterThan((set[1] as any).score);
  });
});
