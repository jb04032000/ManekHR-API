/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { Types } from 'mongoose';
import { FeedService } from '../feed.service';

/**
 * Read-path performance regression coverage for the For-You feed:
 *
 *   1. BATCHING — the number of Mongo READ queries a page issues must be
 *      CONSTANT as the page grows (no per-item lookups). A page of 20 posts
 *      must cost the same reads as a page of 1.
 *   2. BUDGET + CACHING — a warm second page (the per-viewer scoring-input cache
 *      is hot) must stay within the 9-read budget AND drop below the cold count
 *      (proving the cache removes the profile + affinity reads).
 *   3. INSTANT HIDE — a hide tapped between pages drops the post on the very next
 *      page even though the candidate-generation stage is cached (the negative
 *      read is fresh, applied AFTER the cached stage).
 *
 * Models are mocked; a shared counter wraps every `find` / `findOne` so the test
 * asserts on the real query COUNT, not wall time. Discovery is mocked here (its
 * own pool cache is covered in `feed-discovery.service.vitest.ts`).
 */

let reads = 0;

function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

/** A `find`/`findOne` stub that counts each call as one read and returns the
 *  configured result for that call index (last result repeats). */
function countedRead(...resultsInOrder: unknown[]) {
  let i = 0;
  return vi.fn(() => {
    reads += 1;
    const r = resultsInOrder[Math.min(i, resultsInOrder.length - 1)];
    i += 1;
    return chain(r);
  });
}

describe('FeedService — read-path query budget (For-You)', () => {
  let postModel: any;
  let feedEntryModel: any;
  let reactionModel: any;
  let queue: any;
  let profileService: any;
  let erpLinkService: any;
  let ranker: any;
  let discovery: any;
  let negativeModel: any;
  let engagementEdgeModel: any;
  let seenPostModel: any;
  let savedPostModel: any;
  let notifications: any;
  let eventEmitter: any;
  let commentModel: any;
  let tagService: any;
  let companyPages: any;
  let network: any;
  let userBlock: any;
  let media: any;
  const viewer = new Types.ObjectId();

  function build() {
    return new FeedService(
      postModel,
      feedEntryModel,
      reactionModel,
      queue,
      profileService,
      erpLinkService,
      ranker,
      discovery,
      negativeModel,
      engagementEdgeModel,
      seenPostModel,
      savedPostModel,
      notifications,
      eventEmitter,
      commentModel,
      tagService,
      companyPages,
      network,
      userBlock,
      media,
    );
  }

  /** Build a fresh For-You scenario with `n` in-network posts, each by a distinct
   *  author (so author-diversity never trims the page). */
  function setup(n: number, opts?: { negativeRows?: unknown[] }) {
    reads = 0;
    const entries = Array.from({ length: n }, () => ({
      postId: new Types.ObjectId(),
      postedAt: new Date(),
    }));
    const posts = entries.map((e) => ({
      _id: e.postId,
      authorId: new Types.ObjectId(),
      visibility: 'public',
      reactionCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    }));

    feedEntryModel = { find: countedRead(entries) };
    // Query-aware post reads so a SECOND (warm) page stays full: hydrateEntries +
    // loadOriginals filter by `_id`; viewerReposts filters by `repostOf`. Each is
    // one batched query regardless of page size. (loadOriginals early-returns here
    // — no reposts — so it issues no query.) Every call still bumps the counter.
    postModel = {
      find: vi.fn((filter: any) => {
        reads += 1;
        return chain(filter && filter.repostOf ? [] : posts);
      }),
    };
    negativeModel = { find: countedRead(opts?.negativeRows ?? []) };
    userBlock = { find: countedRead([]) };
    seenPostModel = { find: countedRead([]), bulkWrite: vi.fn().mockResolvedValue({}) };
    engagementEdgeModel = { find: countedRead([]) };
    reactionModel = { find: countedRead([]) };
    savedPostModel = { find: countedRead([]) };

    // Non-Mongo collaborators — not counted as DB reads.
    queue = { add: vi.fn() };
    profileService = {
      getRankingSignals: vi.fn().mockResolvedValue({ skills: [], openTo: {}, district: '' }),
    };
    erpLinkService = { getUserStatus: vi.fn() };
    ranker = { key: 'test', rank: vi.fn((p: unknown) => p) };
    discovery = { getCandidates: vi.fn().mockResolvedValue([]) };
    notifications = { dispatch: vi.fn() };
    eventEmitter = { emit: vi.fn() };
    commentModel = { find: vi.fn(() => chain([])) };
    tagService = { normalizeHashtags: vi.fn(), recordUsage: vi.fn() };
    companyPages = { getMine: vi.fn() };
    network = { listConnections: vi.fn().mockResolvedValue([]) };
    media = { assertOwnedMedia: vi.fn() };
  }

  beforeEach(() => {
    reads = 0;
  });

  it('issues the SAME number of reads for a 20-post page as a 1-post page (batched, no per-item)', async () => {
    setup(1);
    await build().getFeed(viewer, 'foryou');
    const readsForOne = reads;

    setup(20);
    await build().getFeed(viewer, 'foryou');
    const readsForTwenty = reads;

    expect(readsForTwenty).toBe(readsForOne);
  });

  it('a warm page stays within the 9-read budget and drops below the cold count', async () => {
    setup(5);
    const svc = build();

    await svc.getFeed(viewer, 'foryou'); // cold — fills the scoring-input cache
    const cold = reads;

    reads = 0;
    await svc.getFeed(viewer, 'foryou'); // warm — signals + affinity served from cache
    const warm = reads;

    // Budget raised 8 -> 9 for the page-scoped media re-hydration (toPage
    // loadMediaByIds): the candidate scans are now media-LIGHT (the heavy inline
    // `media` blob is projected out so ranking never transfers 300KB+/post), and
    // media is re-fetched in ONE batched, indexed query for only the rendered
    // page. Net: +1 tiny read replaces a multi-second media over-fetch on the
    // whole candidate pool. Still batched (no per-item) — see the 20-vs-1 test.
    expect(warm).toBeLessThanOrEqual(9); // hard target: For-You page <= 9 Mongo reads
    expect(warm).toBeLessThan(cold); // caching removed the profile + affinity reads
  });

  it('applies a freshly-tapped hide on the next page even with a warm cache', async () => {
    setup(3);
    const svc = build();

    const first = await svc.getFeed(viewer, 'foryou');
    const hiddenId = first.posts[0]._id;
    expect(first.posts.map((p) => String(p._id))).toContain(String(hiddenId));

    // Re-arm the SAME in-network window, but now the (fresh) negative read returns
    // a hide for the first post. The scoring-input cache is still warm; the hide
    // must still take effect because the negative filter runs after the cache.
    const entries = first.posts.map((p) => ({ postId: p._id, postedAt: new Date() }));
    const posts = first.posts.map((p) => ({
      _id: p._id,
      authorId: p.authorId,
      visibility: 'public',
      reactionCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    }));
    feedEntryModel.find = vi.fn(() => chain(entries));
    postModel.find = countedRead(posts, []);
    negativeModel.find = vi.fn(() => chain([{ kind: 'hide_post', targetId: hiddenId }]));

    const second = await svc.getFeed(viewer, 'foryou');
    expect(second.posts.map((p) => String(p._id))).not.toContain(String(hiddenId));
  });
});
