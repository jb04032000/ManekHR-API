/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
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
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FeedService, type ActivityCommentsPage, type FeedPage } from '../feed.service';
import { FEED_PAGE_SIZE, DISCOVERY_CURSOR } from '../feed.constants';

/**
 * Unit coverage for `FeedService` (Phase 3 — Feed). Verifies the post
 * kind↔payload guards, that creating a post enqueues the fan-out, and the
 * windowed `Following` read. Models / queue / services are mocked — no Mongo.
 */

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

describe('FeedService — feed reads + post lifecycle (Phase 3)', () => {
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
  // Shared media-ownership guard mock so individual tests can override
  // assertOwnedMedia / the server-duration lookups per case.
  let media: any;
  // @mentions (tags) resolver mock — createPost/editPost call resolveForWrite on
  // the write path; default resolves to no tags so existing cases are unaffected.
  let mentionService: any;
  const authorId = new Types.ObjectId();

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
      mentionService,
    );
  }

  beforeEach(() => {
    postModel = {
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId(), createdAt: new Date() }),
      // Default find: for the CN-FEED-12 live-check query
      // ({ _id:{$in}, deletedAt:null } selecting only _id) echo the queried ids
      // as still-live so discovery candidates are not treated as deleted; every
      // OTHER find returns [] (tests that need real rows override this). This
      // keeps the discovery-carried tests green without provisioning the new
      // live-check query in each of them.
      find: vi.fn((filter?: any) => {
        const ids = filter?._id?.$in;
        if (ids && filter?.deletedAt === null) {
          return chain(ids.map((id: unknown) => ({ _id: id })));
        }
        return chain([]);
      }),
      findOne: vi.fn(() => chain(null)),
      updateOne: vi.fn(() => chain({})),
      updateMany: vi.fn(() => chain({})),
    };
    feedEntryModel = {
      updateOne: vi.fn(() => chain({})),
      find: vi.fn(() => chain([])),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
    reactionModel = { find: vi.fn(() => chain([])) };
    queue = { add: vi.fn().mockResolvedValue(undefined) };
    profileService = { getRankingSignals: vi.fn().mockResolvedValue({ skills: [], openTo: {} }) };
    erpLinkService = {
      getUserStatus: vi.fn().mockResolvedValue({ linked: false, since: null, signals: {} }),
    };
    // Ranker is mocked as identity so the existing read-order assertions stay
    // focused on windowing; the strategy's own math is covered in
    // `ranking/__tests__/default-additive.strategy.vitest.ts`.
    ranker = { key: 'test', rank: vi.fn((posts: unknown) => posts) };
    // Discovery mocked empty by default; the cold-start test overrides it.
    discovery = { getCandidates: vi.fn(() => Promise.resolve([])) };
    negativeModel = { find: vi.fn(() => chain([])), updateOne: vi.fn(() => chain({})) };
    // Impressions — view edges + seen rows. `bulkWrite` resolves the mongoose
    // BulkWriteResult shape (`upsertedIds` keyed by op index); empty by default.
    engagementEdgeModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedIds: {} }),
      updateOne: vi.fn(() => chain({})),
      deleteOne: vi.fn(() => chain({})),
      // Post-delete cascade removes a deleted post's view edges (view edges are
      // permanent now — no TTL — so they are trimmed on delete instead).
      deleteMany: vi.fn(() => chain({})),
      // Affinity map (B3) reads the viewer's recent edges; empty by default.
      find: vi.fn(() => chain([])),
    };
    seenPostModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedIds: {} }),
      deleteMany: vi.fn(() => chain({})),
      find: vi.fn(() => chain([])),
    };
    // Saved bookmarks. `find` default empty so `viewerSaves` (called by toPage on
    // every read) reports nothing saved unless a test overrides it.
    savedPostModel = {
      updateOne: vi.fn(() => chain({})),
      deleteOne: vi.fn(() => chain({})),
      find: vi.fn(() => chain([])),
    };
    notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) };
    // Fire-and-forget domain bus (connect.post.changed). Swallows the emit.
    eventEmitter = { emit: vi.fn() };
    // Comments — the profile Activity · Comments tab reads from here. Empty by
    // default; the activity tests override per case.
    commentModel = { find: vi.fn(() => chain([])) };
    // S1.3: hashtags route through TagService. Identity normalize keeps the
    // existing hashtag assertions valid; recordUsage is fire-and-forget.
    tagService = {
      normalizeHashtags: vi.fn((tags: string[]) => Promise.resolve(tags)),
      recordUsage: vi.fn(),
    };
    // Page-post ownership gate. getMine resolves an owned page by default;
    // the ownership-failure test overrides it to reject.
    companyPages = {
      getMine: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    // Visibility gate: no connections by default (only public posts in tests).
    network = {
      listConnections: vi.fn().mockResolvedValue([]),
    };
    // Block enforcement: no blocks by default.
    userBlock = { find: vi.fn(() => chain([])) };
    // Shared media-ownership guard. Accepts any media by default; the
    // server-duration lookups return null (no probe on file) so existing
    // photo/text tests are unaffected. Per-case tests override these.
    media = {
      assertOwnedMedia: vi.fn().mockResolvedValue(undefined),
      getServerAudioDurationByUrl: vi.fn().mockResolvedValue(null),
      getServerVideoDurationByUrl: vi.fn().mockResolvedValue(null),
    };
    // @mentions resolver: no tags by default so the post create/edit assertions
    // here stay focused on lifecycle/windowing (mentions are covered in
    // `feed.service.mentions.vitest.ts`).
    mentionService = {
      resolveForWrite: vi
        .fn()
        .mockResolvedValue({ stored: [], recipientUserIds: [], recipients: [] }),
    };
  });

  it('rejects a photo post with no attachments', async () => {
    await expect(build().createPost(authorId, { kind: 'photo' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a text post with an empty body', async () => {
    await expect(
      build().createPost(authorId, { kind: 'text', body: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a voice post with no recording', async () => {
    await expect(build().createPost(authorId, { kind: 'voice' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('creates a text post — writes the author feed entry and enqueues the fan-out', async () => {
    await build().createPost(authorId, { kind: 'text', body: 'Finished a bridal order #zari' });
    expect(postModel.create).toHaveBeenCalled();
    expect(feedEntryModel.updateOne).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
    // Search-index seam — a create emits connect.post.changed.
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'connect.post.changed',
      expect.objectContaining({ change: 'created' }),
    );
  });

  it('createPost stores the chosen mediaLayout on a multi-photo post', async () => {
    await build().createPost(authorId, {
      kind: 'photo',
      media: [
        { url: 'https://cdn.test/a.png', type: 'image' },
        { url: 'https://cdn.test/b.png', type: 'image' },
      ],
      mediaLayout: 'carousel',
    });
    expect(postModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ mediaLayout: 'carousel' }),
    );
  });

  it('createPost defaults a photo post to grid when no layout is chosen', async () => {
    await build().createPost(authorId, {
      kind: 'photo',
      media: [{ url: 'https://cdn.test/a.png', type: 'image' }],
    });
    expect(postModel.create).toHaveBeenCalledWith(expect.objectContaining({ mediaLayout: 'grid' }));
  });

  it('createPost forces grid on a non-photo post even if a layout is sent', async () => {
    await build().createPost(authorId, {
      kind: 'text',
      body: 'no carousel here',
      mediaLayout: 'carousel',
    });
    expect(postModel.create).toHaveBeenCalledWith(expect.objectContaining({ mediaLayout: 'grid' }));
  });

  // ── video posts: poster + server duration ────────────────────────────────
  it('createPost includes a video posterUrl in the ownership check and persists it', async () => {
    await build().createPost(authorId, {
      kind: 'video',
      media: [
        {
          url: 'https://cdn.test/clip.mp4',
          type: 'video',
          posterUrl: 'https://cdn.test/poster.jpg',
        },
      ],
    });
    // The poster image is ownership-checked alongside the video url.
    expect(media.assertOwnedMedia).toHaveBeenCalledWith(
      expect.arrayContaining(['https://cdn.test/clip.mp4', 'https://cdn.test/poster.jpg']),
      expect.anything(),
    );
    const created = postModel.create.mock.calls[0][0];
    expect(created.media[0].posterUrl).toBe('https://cdn.test/poster.jpg');
  });

  it('createPost rejects a video whose poster the caller does not own (no post written)', async () => {
    // The guard throws when it sees a not-owned url (here, the poster).
    media.assertOwnedMedia = vi.fn().mockRejectedValue(new BadRequestException('not yours'));
    await expect(
      build().createPost(authorId, {
        kind: 'video',
        media: [
          {
            url: 'https://cdn.test/clip.mp4',
            type: 'video',
            posterUrl: 'https://cdn.test/theirs.jpg',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postModel.create).not.toHaveBeenCalled();
  });

  it('createPost accepts a posterless video post (still valid)', async () => {
    await build().createPost(authorId, {
      kind: 'video',
      media: [{ url: 'https://cdn.test/clip.mp4', type: 'video' }],
    });
    const created = postModel.create.mock.calls[0][0];
    expect(created.media[0].posterUrl).toBeUndefined();
    expect(created.kind).toBe('video');
  });

  it('createPost stamps the SERVER-parsed video duration onto the media item', async () => {
    media.getServerVideoDurationByUrl = vi.fn().mockResolvedValue(95);
    await build().createPost(authorId, {
      kind: 'video',
      media: [{ url: 'https://cdn.test/clip.mp4', type: 'video' }],
    });
    const created = postModel.create.mock.calls[0][0];
    expect(created.media[0].durationSec).toBe(95);
  });

  // ── page posts ─────────────────────────────────────────────────────────
  it('createPost as a company page verifies ownership and stamps companyPageId', async () => {
    const pageId = new Types.ObjectId();
    companyPages.getMine = vi.fn().mockResolvedValue({ _id: pageId });

    await build().createPost(authorId, {
      kind: 'text',
      body: 'Festive collection is live',
      companyPageId: String(pageId),
    });

    expect(companyPages.getMine).toHaveBeenCalledWith(String(authorId), String(pageId));
    expect(postModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyPageId: pageId }),
    );
    // The fan-out job carries the page id so the worker targets page followers.
    expect(queue.add).toHaveBeenCalledWith(
      'fanout',
      expect.objectContaining({ companyPageId: String(pageId) }),
      expect.anything(),
    );
  });

  it('createPost rejects a company page the caller does not own (no post written)', async () => {
    companyPages.getMine = vi.fn().mockRejectedValue(new Error('Company page not found'));

    await expect(
      build().createPost(authorId, {
        kind: 'text',
        body: 'not my page',
        companyPageId: String(new Types.ObjectId()),
      }),
    ).rejects.toThrow();
    expect(postModel.create).not.toHaveBeenCalled();
  });

  it('a personal post stamps companyPageId null and carries no page id in the job', async () => {
    await build().createPost(authorId, { kind: 'text', body: 'personal update' });
    expect(postModel.create).toHaveBeenCalledWith(expect.objectContaining({ companyPageId: null }));
    expect(companyPages.getMine).not.toHaveBeenCalled();
    expect(queue.add.mock.calls[0][1].companyPageId).toBeUndefined();
  });

  it('reads the Following feed in chronological order, flagging the caught-up end', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() =>
      chain([
        { postId: p1, postedAt: new Date('2026-02-02') },
        { postId: p2, postedAt: new Date('2026-02-01') },
      ]),
    );
    postModel.find = vi.fn(() =>
      chain([
        { _id: p2, reactionCount: 0, commentCount: 0, createdAt: new Date('2026-02-01') },
        { _id: p1, reactionCount: 0, commentCount: 0, createdAt: new Date('2026-02-02') },
      ]),
    );

    const page = await build().getFeed(authorId, 'following');

    expect(page.posts.map((p) => String(p._id))).toEqual([String(p1), String(p2)]);
    expect(page.caughtUp).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  // Perf fix: the candidate window is scanned media-LIGHT (the heavy inline
  // `media` blob is projected out so the ranking scan does not transfer it), and
  // `media` is re-hydrated by id for ONLY the rendered page. This asserts a
  // media-light candidate still renders with its media populated.
  it('re-hydrates display media onto the rendered page even when the candidate scan is media-light', async () => {
    const pid = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([{ postId: pid, postedAt: new Date() }]));
    postModel.find = vi.fn((filter?: any) => {
      const ids = filter?._id?.$in;
      // Candidate hydrate (in-network window): media-LIGHT post (no media field).
      if (ids && filter?.deletedAt === null) {
        return chain(
          ids.map((id: any) => ({
            _id: id,
            authorId,
            visibility: 'public',
            body: 'hi',
            hashtags: [],
            authorSkills: [],
            reactionCount: 0,
            commentCount: 0,
            createdAt: new Date(),
          })),
        );
      }
      // Media re-hydration by id (the only find with no deletedAt filter).
      if (ids) {
        return chain(ids.map((id: any) => ({ _id: id, media: [{ url: 'https://cdn/a.jpg' }] })));
      }
      return chain([]);
    });

    const page = await build().getFeed(authorId, 'following');

    expect(page.posts).toHaveLength(1);
    expect(page.posts[0].media).toEqual([{ url: 'https://cdn/a.jpg' }]);
  });

  it('For You cold-start — an empty in-network feed is carried by discovery', async () => {
    feedEntryModel.find = vi.fn(() => chain([])); // viewer follows no one
    const discoveryPost = {
      _id: new Types.ObjectId(),
      reactionCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    };
    discovery.getCandidates = vi.fn(() =>
      Promise.resolve([{ post: discoveryPost, sourceScore: 1, origin: 'trending' }]),
    );

    const page = await build().getFeed(authorId, 'foryou');

    expect(discovery.getCandidates).toHaveBeenCalled();
    expect(page.posts.map((p) => String(p._id))).toEqual([String(discoveryPost._id)]);
  });

  it('For You enriches a deep (cursor) page with discovery too (F7), not page 1 only', async () => {
    await build().getFeed(authorId, 'foryou', new Date().toISOString());
    expect(discovery.getCandidates).toHaveBeenCalled();
  });

  it('CN-FEED-12: drops a discovery candidate whose post was since deleted (cache staleness)', async () => {
    feedEntryModel.find = vi.fn(() => chain([])); // no in-network
    const live = {
      _id: new Types.ObjectId(),
      reactionCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    };
    const deleted = {
      _id: new Types.ObjectId(),
      reactionCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    };
    discovery.getCandidates = vi.fn(() =>
      Promise.resolve([
        { post: live, sourceScore: 2, origin: 'trending' },
        { post: deleted, sourceScore: 1, origin: 'trending' },
      ]),
    );
    // The CN-FEED-12 live-check returns ONLY `live` (the `deleted` id is gone).
    postModel.find = vi.fn((filter?: any) => {
      if (filter?._id?.$in && filter?.deletedAt === null) return chain([{ _id: live._id }]);
      return chain([]);
    });

    const page = await build().getFeed(authorId, 'foryou');

    const ids = page.posts.map((p) => String(p._id));
    expect(ids).toContain(String(live._id));
    expect(ids).not.toContain(String(deleted._id));
  });

  it('Following never queries discovery', async () => {
    await build().getFeed(authorId, 'following');
    expect(discovery.getCandidates).not.toHaveBeenCalled();
  });

  it('drops a connections-only post when the viewer is not connected to the author (F3)', async () => {
    const stranger = new Types.ObjectId();
    const postId = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([{ postId, postedAt: new Date() }]));
    postModel.find = vi.fn(() =>
      chain([
        {
          _id: postId,
          authorId: stranger,
          visibility: 'connections',
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
      ]),
    );
    network.listConnections = vi.fn().mockResolvedValue([]); // viewer follows but is not connected
    const page = await build().getFeed(authorId, 'following');
    expect(page.posts).toHaveLength(0);
    expect(network.listConnections).toHaveBeenCalled();
  });

  it('drops a post authored by a blocked user, either direction (A1)', async () => {
    const blockedAuthor = new Types.ObjectId();
    const postId = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([{ postId, postedAt: new Date() }]));
    postModel.find = vi.fn(() =>
      chain([
        {
          _id: postId,
          authorId: blockedAuthor,
          visibility: 'public',
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
      ]),
    );
    // The viewer blocked this author (blockerUserId = viewer).
    userBlock.find = vi.fn(() =>
      chain([{ blockerUserId: authorId, blockedUserId: blockedAuthor }]),
    );
    const page = await build().getFeed(authorId, 'following');
    expect(page.posts).toHaveLength(0);
  });

  it('keeps a connections-only post when the viewer IS connected to the author (F3)', async () => {
    const friend = new Types.ObjectId();
    const postId = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([{ postId, postedAt: new Date() }]));
    postModel.find = vi.fn(() =>
      chain([
        {
          _id: postId,
          authorId: friend,
          visibility: 'connections',
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
      ]),
    );
    network.listConnections = vi
      .fn()
      .mockResolvedValue([{ userId: String(friend), since: new Date() }]);
    const page = await build().getFeed(authorId, 'following');
    expect(page.posts).toHaveLength(1);
  });

  it('For You caps a single author to 3 posts per page (author diversity)', async () => {
    const prolific = new Types.ObjectId();
    const entries = Array.from({ length: 5 }, () => ({
      postId: new Types.ObjectId(),
      postedAt: new Date(),
    }));
    feedEntryModel.find = vi.fn(() => chain(entries));
    // All five in-network posts are by the same prolific author.
    postModel.find = vi.fn(() =>
      chain(
        entries.map((e) => ({
          _id: e.postId,
          authorId: prolific,
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        })),
      ),
    );

    const page = await build().getFeed(authorId, 'foryou');

    // MAX_POSTS_PER_AUTHOR = 3 — the wall of one author is capped.
    expect(page.posts).toHaveLength(3);
  });

  it('paginates discovery for a zero-network viewer via the sentinel cursor (C1)', async () => {
    feedEntryModel.find = vi.fn(() => chain([])); // no in-network entries
    const dpost = {
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      visibility: 'public',
      reactionCount: 0,
      commentCount: 0,
      createdAt: new Date(),
    };
    discovery.getCandidates = vi
      .fn()
      .mockResolvedValue([{ post: dpost, origin: 'trending', reason: 'trending', sourceScore: 1 }]);
    const page = await build().getFeed(authorId, 'foryou');
    expect(page.posts.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBe('discovery');
    expect(page.caughtUp).toBe(false);
  });

  it('skips the in-network query on a discovery-continuation cursor (C1)', async () => {
    discovery.getCandidates = vi.fn().mockResolvedValue([]);
    await build().getFeed(authorId, 'foryou', 'discovery');
    // The sentinel cursor must not hit the materialized timeline.
    expect(feedEntryModel.find).not.toHaveBeenCalled();
  });

  it('dedupes a root post and its repost in one page (C2)', async () => {
    const root = new Types.ObjectId();
    const repostId = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() =>
      chain([
        { postId: repostId, postedAt: new Date() },
        { postId: root, postedAt: new Date() },
      ]),
    );
    postModel.find = vi.fn(() =>
      chain([
        {
          _id: repostId,
          authorId: new Types.ObjectId(),
          repostOf: root,
          visibility: 'public',
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
        {
          _id: root,
          authorId: new Types.ObjectId(),
          visibility: 'public',
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
      ]),
    );
    const page = await build().getFeed(authorId, 'following');
    expect(page.posts).toHaveLength(1);
  });

  it('For You drops a hidden post, a not-interested post, + all posts by a muted author', async () => {
    const mutedAuthor = new Types.ObjectId();
    const hiddenPost = new Types.ObjectId();
    const notInterestedPost = new Types.ObjectId();
    const okPost = new Types.ObjectId();
    const mutedPost = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() =>
      chain(
        [hiddenPost, notInterestedPost, okPost, mutedPost].map((id) => ({
          postId: id,
          postedAt: new Date(),
        })),
      ),
    );
    postModel.find = vi.fn(() =>
      chain([
        {
          _id: hiddenPost,
          authorId: new Types.ObjectId(),
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
        {
          _id: notInterestedPost,
          authorId: new Types.ObjectId(),
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
        {
          _id: okPost,
          authorId: new Types.ObjectId(),
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
        {
          _id: mutedPost,
          authorId: mutedAuthor,
          reactionCount: 0,
          commentCount: 0,
          createdAt: new Date(),
        },
      ]),
    );
    negativeModel.find = vi.fn(() =>
      chain([
        { kind: 'hide_post', targetId: hiddenPost },
        // not-interested now hard-excludes from the feed query too (not just dampens).
        { kind: 'not_interested', targetId: notInterestedPost, createdAt: new Date() },
        { kind: 'mute_author', targetId: mutedAuthor },
      ]),
    );

    const page = await build().getFeed(authorId, 'foryou');
    const ids = page.posts.map((p) => String(p._id));

    expect(ids).toContain(String(okPost));
    expect(ids).not.toContain(String(hiddenPost));
    expect(ids).not.toContain(String(notInterestedPost));
    expect(ids).not.toContain(String(mutedPost));
  });

  it('addNegativeSignal upserts the signal', async () => {
    await build().addNegativeSignal(authorId, 'hide_post', new Types.ObjectId().toHexString());
    expect(negativeModel.updateOne).toHaveBeenCalled();
  });

  it('recordViews writes view edges + seen rows and bumps viewCount for first views', async () => {
    const other = new Types.ObjectId();
    const id1 = new Types.ObjectId();
    const id2 = new Types.ObjectId();
    postModel.find = vi.fn(() =>
      chain([
        { _id: id1, authorId: other },
        { _id: id2, authorId: other },
      ]),
    );
    // Both edges are newly inserted (first unique views) → upsertedIds by index.
    engagementEdgeModel.bulkWrite = vi
      .fn()
      .mockResolvedValue({ upsertedIds: { 0: new Types.ObjectId(), 1: new Types.ObjectId() } });

    const res = await build().recordViews(authorId, [id1.toHexString(), id2.toHexString()]);

    expect(res.recorded).toBe(2);
    expect(engagementEdgeModel.bulkWrite).toHaveBeenCalled();
    expect(seenPostModel.bulkWrite).toHaveBeenCalled();
    expect(postModel.updateMany).toHaveBeenCalled(); // viewCount $inc for the two first views
  });

  it('recordViews excludes the author viewing their own post', async () => {
    const ownPost = new Types.ObjectId();
    postModel.find = vi.fn(() => chain([{ _id: ownPost, authorId }])); // viewer IS the author

    const res = await build().recordViews(authorId, [ownPost.toHexString()]);

    expect(res.recorded).toBe(0);
    expect(engagementEdgeModel.bulkWrite).not.toHaveBeenCalled();
    expect(postModel.updateMany).not.toHaveBeenCalled();
  });

  it('recordViews does not bump viewCount when no new edge was inserted (re-view)', async () => {
    const other = new Types.ObjectId();
    const id1 = new Types.ObjectId();
    postModel.find = vi.fn(() => chain([{ _id: id1, authorId: other }]));
    engagementEdgeModel.bulkWrite = vi.fn().mockResolvedValue({ upsertedIds: {} }); // already viewed

    const res = await build().recordViews(authorId, [id1.toHexString()]);

    expect(res.recorded).toBe(1);
    expect(postModel.updateMany).not.toHaveBeenCalled();
    expect(seenPostModel.bulkWrite).toHaveBeenCalled(); // still marked seen
  });

  it('recordViews is a no-op on an empty / all-invalid id list', async () => {
    const res = await build().recordViews(authorId, ['not-an-id']);
    expect(res.recorded).toBe(0);
    expect(engagementEdgeModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('repost creates a repost, fans it out, bumps the count, and notifies the root author', async () => {
    const original = new Types.ObjectId();
    const rootAuthor = new Types.ObjectId();
    const repostId = new Types.ObjectId();
    // findOne call 1 = original lookup; call 2 = existing-plain-repost (none).
    postModel.findOne = vi
      .fn()
      .mockReturnValueOnce(chain({ _id: original, authorId: rootAuthor, repostOf: null }))
      .mockReturnValue(chain(null));
    postModel.create = vi.fn().mockResolvedValue({ _id: repostId, createdAt: new Date() });

    const created = await build().repost(authorId, original.toHexString());

    expect(String(created._id)).toBe(String(repostId));
    expect(postModel.create).toHaveBeenCalled();
    expect(feedEntryModel.updateOne).toHaveBeenCalled(); // inline author feed entry
    expect(queue.add).toHaveBeenCalled(); // follower fan-out
    expect(postModel.updateOne).toHaveBeenCalled(); // $inc repostCount
    expect(engagementEdgeModel.updateOne).toHaveBeenCalled(); // repost edge
    expect(notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'connect.post_reposted' }),
    );
  });

  it('repost is idempotent for a plain repost — returns the existing one, no new create', async () => {
    const original = new Types.ObjectId();
    const rootAuthor = new Types.ObjectId();
    const existing = new Types.ObjectId();
    postModel.findOne = vi
      .fn()
      .mockReturnValueOnce(chain({ _id: original, authorId: rootAuthor, repostOf: null }))
      .mockReturnValueOnce(chain({ _id: existing, repostOf: original }));
    postModel.create = vi.fn();

    const created = await build().repost(authorId, original.toHexString());

    expect(String(created._id)).toBe(String(existing));
    expect(postModel.create).not.toHaveBeenCalled();
  });

  it('deletePost soft-deletes and cascades the post view edges + seen rows', async () => {
    const postId = new Types.ObjectId();
    const postDoc = {
      _id: postId,
      authorId, // viewer IS the author → delete allowed
      deletedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await build().deletePost(authorId, postId.toHexString());

    expect(postDoc.save).toHaveBeenCalled(); // soft-delete persisted
    expect(feedEntryModel.deleteMany).toHaveBeenCalledWith({ postId });
    // View edges are permanent (no TTL); trim them on delete so storage is bound
    // by live content, and the lifetime-unique count never re-counts a re-view.
    expect(engagementEdgeModel.deleteMany).toHaveBeenCalledWith({ postId, type: 'view' });
    expect(seenPostModel.deleteMany).toHaveBeenCalledWith({ postId });
  });

  it('unrepost soft-deletes the plain repost and decrements the root tally', async () => {
    const original = new Types.ObjectId();
    const repostId = new Types.ObjectId();
    postModel.findOne = vi
      .fn()
      .mockReturnValueOnce(chain({ repostOf: null })) // original (resolve root)
      .mockReturnValueOnce(chain({ _id: repostId })); // the caller's plain repost

    await build().unrepost(authorId, original.toHexString());

    expect(postModel.updateOne).toHaveBeenCalled(); // soft-delete + decrement
    expect(engagementEdgeModel.deleteOne).toHaveBeenCalled();
  });

  it('embeds the root original on a repost in the feed read', async () => {
    const repostId = new Types.ObjectId();
    const rootId = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([{ postId: repostId, postedAt: new Date() }]));
    postModel.find = vi
      .fn()
      // hydrateEntries — the repost itself
      .mockReturnValueOnce(
        chain([
          {
            _id: repostId,
            authorId: new Types.ObjectId(),
            repostOf: rootId,
            reactionCount: 0,
            commentCount: 0,
            createdAt: new Date(),
          },
        ]),
      )
      // loadOriginals — the embedded root
      .mockReturnValueOnce(chain([{ _id: rootId, body: 'the original', reactionCount: 0 }]))
      // viewerReposts — the viewer has not reposted anything here
      .mockReturnValue(chain([]));

    const page = await build().getFeed(authorId, 'following');

    expect(page.posts).toHaveLength(1);
    expect(String(page.posts[0].original?._id)).toBe(String(rootId));
  });

  it('For You DAMPENS (does not exclude) already-seen posts on a normal page (Phase 7d)', async () => {
    const seenId = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([])); // empty in-network
    seenPostModel.find = vi.fn(() => chain([{ postId: seenId }]));

    await build().getFeed(authorId, 'foryou');

    // Seen posts are no longer EXCLUDED from discovery — they stay eligible and
    // the ranker applies a penalty, so they fade rather than vanish.
    const exclude = discovery.getCandidates.mock.calls[0][1] as Set<string>;
    expect(exclude.has(String(seenId))).toBe(false);
    // Instead the seen id is handed to the ranker as a dampening signal.
    const signals = ranker.rank.mock.calls[0][1] as { seenPostIds: Set<string> };
    expect(signals.seenPostIds.has(String(seenId))).toBe(true);
  });

  it('For You still excludes seen posts on the pure-discovery continuation (scroll advances)', async () => {
    const seenId = new Types.ObjectId();
    seenPostModel.find = vi.fn(() => chain([{ postId: seenId }]));

    // The discovery-continuation sentinel cursor skips the in-network query and
    // paginates pure discovery — here seen posts ARE excluded so each page moves
    // forward instead of re-serving the same (dampened) candidates.
    await build().getFeed(authorId, 'foryou', DISCOVERY_CURSOR);

    const exclude = discovery.getCandidates.mock.calls[0][1] as Set<string>;
    expect(exclude.has(String(seenId))).toBe(true);
  });

  // ── Saved posts ──────────────────────────────────────────────────────────

  it('savePost upserts the bookmark for a live post', async () => {
    const postId = new Types.ObjectId();
    postModel.findOne = vi.fn(() => chain({ _id: postId })); // resolveRootId (no repostOf -> root is itself)

    const res = await build().savePost(authorId, postId.toHexString());

    expect(res).toEqual({ saved: true });
    expect(savedPostModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authorId, postId }),
      expect.objectContaining({ $setOnInsert: expect.anything() }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('savePost saves the ROOT when given a repost id (bookmark survives the wrapper)', async () => {
    const repostId = new Types.ObjectId();
    const rootId = new Types.ObjectId();
    postModel.findOne = vi.fn(() => chain({ _id: repostId, repostOf: rootId }));

    await build().savePost(authorId, repostId.toHexString());

    expect(savedPostModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authorId, postId: rootId }),
      expect.objectContaining({ $setOnInsert: expect.anything() }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('savePost 404s on a missing or deleted post', async () => {
    postModel.findOne = vi.fn(() => chain(null));
    await expect(
      build().savePost(authorId, new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(savedPostModel.updateOne).not.toHaveBeenCalled();
  });

  it('unsavePost removes the bookmark and tolerates a missing one', async () => {
    const res = await build().unsavePost(authorId, new Types.ObjectId().toHexString());
    expect(res).toEqual({ saved: false });
    expect(savedPostModel.deleteOne).toHaveBeenCalled();
  });

  it('listSaved returns saved posts newest-first, flagged viewerSaved', async () => {
    const p1 = new Types.ObjectId();
    // Window query (newest-saved first) → one saved row; viewerSaves (in toPage)
    // → the same id, so the rendered item reports viewerSaved true.
    savedPostModel.find = vi
      .fn()
      .mockReturnValueOnce(chain([{ postId: p1, createdAt: new Date('2026-02-02') }]))
      .mockReturnValue(chain([{ postId: p1 }]));
    // hydrate the live post, then viewerReposts → none.
    postModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([{ _id: p1, reactionCount: 0, commentCount: 0, createdAt: new Date('2026-01-01') }]),
      )
      .mockReturnValue(chain([]));

    const page = await build().listSaved(authorId);

    expect(page.posts.map((p) => String(p._id))).toEqual([String(p1)]);
    expect(page.posts[0].viewerSaved).toBe(true);
    expect(page.caughtUp).toBe(true);
  });

  it('a feed read flags viewerSaved for a post the viewer saved', async () => {
    const p1 = new Types.ObjectId();
    feedEntryModel.find = vi.fn(() => chain([{ postId: p1, postedAt: new Date() }]));
    postModel.find = vi.fn(() =>
      chain([{ _id: p1, reactionCount: 0, commentCount: 0, createdAt: new Date() }]),
    );
    savedPostModel.find = vi.fn(() => chain([{ postId: p1 }])); // viewer has saved it

    const page = await build().getFeed(authorId, 'following');

    expect(page.posts[0].viewerSaved).toBe(true);
  });

  // ── Edit post ──────────────────────────────────────────────────────────────

  it('editPost updates the body, re-parses hashtags, stamps editedAt, and emits', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const postDoc: any = { _id: new Types.ObjectId(), authorId, kind: 'text', body: 'old', save };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await build().editPost(authorId, postDoc._id.toHexString(), { body: 'new body #zari' });

    expect(postDoc.body).toBe('new body #zari');
    expect(postDoc.hashtags).toEqual(['zari']);
    expect(postDoc.editedAt).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'connect.post.changed',
      expect.objectContaining({ change: 'updated' }),
    );
  });

  it('editPost flips mediaLayout on a photo post', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const postDoc: any = {
      _id: new Types.ObjectId(),
      authorId,
      kind: 'photo',
      body: '',
      mediaLayout: 'grid',
      save,
    };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await build().editPost(authorId, postDoc._id.toHexString(), { mediaLayout: 'carousel' });

    expect(postDoc.mediaLayout).toBe('carousel');
    // A display-only layout flip is not a content edit, so it must not stamp editedAt.
    expect(postDoc.editedAt).toBeUndefined();
    expect(save).toHaveBeenCalled();
  });

  it('editPost ignores mediaLayout on a non-photo post', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const postDoc: any = { _id: new Types.ObjectId(), authorId, kind: 'text', body: 'x', save };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await build().editPost(authorId, postDoc._id.toHexString(), { mediaLayout: 'carousel' });

    expect(postDoc.mediaLayout).toBeUndefined();
    expect(save).toHaveBeenCalled();
  });

  it('editPost forbids editing another author post', async () => {
    const postDoc: any = {
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(), // not the caller
      kind: 'text',
      body: 'x',
      save: vi.fn(),
    };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await expect(
      build().editPost(authorId, postDoc._id.toHexString(), { body: 'y' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(postDoc.save).not.toHaveBeenCalled();
  });

  it('editPost rejects emptying a text post', async () => {
    const postDoc: any = {
      _id: new Types.ObjectId(),
      authorId,
      kind: 'text',
      body: 'x',
      save: vi.fn(),
    };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await expect(
      build().editPost(authorId, postDoc._id.toHexString(), { body: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('editPost 404s on a missing post', async () => {
    postModel.findOne = vi.fn(() => chain(null));
    await expect(
      build().editPost(authorId, new Types.ObjectId().toHexString(), { body: 'y' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('editPost rejects editing a repost (a wrapper, not editable content)', async () => {
    const postDoc: any = {
      _id: new Types.ObjectId(),
      authorId,
      kind: 'text',
      body: '',
      repostOf: new Types.ObjectId(),
      save: vi.fn(),
    };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await expect(
      build().editPost(authorId, postDoc._id.toHexString(), { body: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postDoc.save).not.toHaveBeenCalled();
  });

  it('deletePost emits post-changed with change deleted', async () => {
    const postDoc: any = {
      _id: new Types.ObjectId(),
      authorId,
      save: vi.fn().mockResolvedValue(undefined),
    };
    postModel.findOne = vi.fn(() => chain(postDoc));

    await build().deletePost(authorId, postDoc._id.toHexString());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'connect.post.changed',
      expect.objectContaining({ change: 'deleted' }),
    );
    // F6 — the post's fanned-out feed rows are removed immediately.
    expect(feedEntryModel.deleteMany).toHaveBeenCalledWith({ postId: postDoc._id });
  });

  // ── Profile activity (own posts / comments / reactions) ────────────────────

  it('activity posts — the caller own posts newest-first, hydrated like the feed', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    // First find = the authored-posts window; later finds (toPage's
    // loadOriginals / viewerReposts) resolve empty.
    postModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([
          {
            _id: p1,
            authorId,
            reactionCount: 0,
            commentCount: 0,
            createdAt: new Date('2026-02-02'),
          },
          {
            _id: p2,
            authorId,
            reactionCount: 0,
            commentCount: 0,
            createdAt: new Date('2026-02-01'),
          },
        ]),
      )
      .mockReturnValue(chain([]));

    const page = (await build().getActivity(authorId, 'posts')) as FeedPage;

    expect(page.posts.map((p) => String(p._id))).toEqual([String(p1), String(p2)]);
    expect(page.caughtUp).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it('activity reactions — the posts the caller liked, in reaction order, since-deleted dropped', async () => {
    const liked = new Types.ObjectId();
    const deleted = new Types.ObjectId();
    reactionModel.find = vi.fn(() =>
      chain([
        { postId: liked, createdAt: new Date('2026-02-02') },
        { postId: deleted, createdAt: new Date('2026-02-01') },
      ]),
    );
    // Only the live post hydrates back (deleted one filtered by deletedAt:null);
    // later toPage reads resolve empty.
    postModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([
          {
            _id: liked,
            authorId: new Types.ObjectId(),
            reactionCount: 1,
            commentCount: 0,
            createdAt: new Date(),
          },
        ]),
      )
      .mockReturnValue(chain([]));

    const page = (await build().getActivity(authorId, 'reactions')) as FeedPage;

    expect(page.posts.map((p) => String(p._id))).toEqual([String(liked)]);
    expect(page.caughtUp).toBe(true);
  });

  it('activity comments — the caller comments, each with its parent-post preview', async () => {
    const c1 = new Types.ObjectId();
    const parent = new Types.ObjectId();
    commentModel.find = vi.fn(() =>
      chain([{ _id: c1, postId: parent, body: 'great work', createdAt: new Date('2026-02-02') }]),
    );
    postModel.find = vi.fn(() =>
      chain([
        {
          _id: parent,
          authorId: new Types.ObjectId(),
          body: 'the post',
          reactionCount: 0,
          commentCount: 1,
          createdAt: new Date(),
        },
      ]),
    );

    const page = (await build().getActivity(authorId, 'comments')) as ActivityCommentsPage;

    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].body).toBe('great work');
    expect(String(page.comments[0].post?._id)).toBe(String(parent));
    expect(page.caughtUp).toBe(true);
  });

  it('activity comments — a since-deleted parent yields post:null, the comment still lists', async () => {
    const c1 = new Types.ObjectId();
    const goneParent = new Types.ObjectId();
    commentModel.find = vi.fn(() =>
      chain([{ _id: c1, postId: goneParent, body: 'orphan', createdAt: new Date() }]),
    );
    postModel.find = vi.fn(() => chain([])); // parent filtered by deletedAt:null

    const page = (await build().getActivity(authorId, 'comments')) as ActivityCommentsPage;

    expect(page.comments).toHaveLength(1);
    expect(page.comments[0].post).toBeNull();
  });

  // ── Public profile activity (a user's PUBLIC posts, on OTHER profiles) ──────

  it('public activity — the owner public posts newest-first, raw (no viewer state)', async () => {
    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    postModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([
          { _id: p1, authorId, createdAt: new Date('2026-02-02') },
          { _id: p2, authorId, createdAt: new Date('2026-02-01') },
        ]),
      )
      .mockReturnValue(chain([]));

    const page = await build().getPublicActivity(authorId);

    expect(page.posts.map((p) => String(p._id))).toEqual([String(p1), String(p2)]);
    expect(page.caughtUp).toBe(true);
    expect(page.nextCursor).toBeNull();
    // RAW — no `toPage` enrichment for a (possibly logged-out) public viewer.
    expect(page.posts[0]).not.toHaveProperty('viewerReacted');
    expect(page.posts[0]).not.toHaveProperty('viewerSaved');
  });

  it('public activity — filters to the author public, non-deleted posts only', async () => {
    const find = vi.fn().mockReturnValue(chain([]));
    postModel.find = find;

    await build().getPublicActivity(authorId);

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ authorId, visibility: 'public', deletedAt: null }),
    );
  });

  it('public activity — a full page sets nextCursor to the last post createdAt, caughtUp false', async () => {
    const posts = Array.from({ length: FEED_PAGE_SIZE }, (_, i) => ({
      _id: new Types.ObjectId(),
      authorId,
      createdAt: new Date(Date.UTC(2026, 1, FEED_PAGE_SIZE - i)),
    }));
    postModel.find = vi.fn().mockReturnValueOnce(chain(posts)).mockReturnValue(chain([]));

    const page = await build().getPublicActivity(authorId);

    expect(page.caughtUp).toBe(false);
    expect(page.nextCursor).toBe(posts[posts.length - 1].createdAt.toISOString());
  });

  it('public activity — applies the createdAt cursor when provided', async () => {
    const find = vi.fn().mockReturnValue(chain([]));
    postModel.find = find;
    const cursor = '2026-02-01T00:00:00.000Z';

    await build().getPublicActivity(authorId, cursor);

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: { $lt: new Date(cursor) } }),
    );
  });

  it('public activity — a repost embeds its public ROOT original; a plain post has none', async () => {
    const plain = new Types.ObjectId();
    const repost = new Types.ObjectId();
    const root = new Types.ObjectId();
    postModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([
          { _id: repost, authorId, repostOf: root, createdAt: new Date('2026-02-02') },
          { _id: plain, authorId, createdAt: new Date('2026-02-01') },
        ]),
      )
      // embedPublicOriginals — the public, live original
      .mockReturnValueOnce(chain([{ _id: root, authorId: new Types.ObjectId(), body: 'root' }]));

    const page = await build().getPublicActivity(authorId);

    expect(String(page.posts[0].original?._id)).toBe(String(root));
    expect(page.posts[1].original).toBeUndefined();
  });

  it('public activity — a repost whose original is gone / private yields original:null', async () => {
    const repost = new Types.ObjectId();
    const root = new Types.ObjectId();
    postModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([{ _id: repost, authorId, repostOf: root, createdAt: new Date('2026-02-02') }]),
      )
      .mockReturnValueOnce(chain([])); // original missing / not public

    const page = await build().getPublicActivity(authorId);

    expect(page.posts[0].original).toBeNull();
  });
});
