/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing FeedService so the
// transitive schema imports don't trip vitest's reflect-metadata pipeline.
// All Models are injected as plain mocks; no real Mongoose is used.
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
 * Focused coverage for the @mentions (tags) write-path wiring in `createPost`.
 * Verifies that FeedService resolves tags through MentionService and persists
 * the returned STORED mentions onto the post (href computed server-side). Models
 * / queue / services are mocked - no Mongo.
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

describe('FeedService - @mentions on the post write path', () => {
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
      find: vi.fn(() => chain([])),
      findOne: vi.fn(() => chain(null)),
      updateOne: vi.fn(() => chain({})),
      updateMany: vi.fn(() => chain({})),
    };
    feedEntryModel = { updateOne: vi.fn(() => chain({})), find: vi.fn(() => chain([])) };
    reactionModel = { find: vi.fn(() => chain([])) };
    queue = { add: vi.fn().mockResolvedValue(undefined) };
    profileService = { getRankingSignals: vi.fn().mockResolvedValue({ skills: [], openTo: {} }) };
    erpLinkService = {
      getUserStatus: vi.fn().mockResolvedValue({ linked: false, since: null, signals: {} }),
    };
    ranker = { key: 'test', rank: vi.fn((posts: unknown) => posts) };
    discovery = { getCandidates: vi.fn(() => Promise.resolve([])) };
    negativeModel = { find: vi.fn(() => chain([])), updateOne: vi.fn(() => chain({})) };
    engagementEdgeModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedIds: {} }),
      updateOne: vi.fn(() => chain({})),
      deleteOne: vi.fn(() => chain({})),
      find: vi.fn(() => chain([])),
    };
    seenPostModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedIds: {} }),
      find: vi.fn(() => chain([])),
    };
    savedPostModel = {
      updateOne: vi.fn(() => chain({})),
      deleteOne: vi.fn(() => chain({})),
      find: vi.fn(() => chain([])),
    };
    notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) };
    eventEmitter = { emit: vi.fn() };
    commentModel = { find: vi.fn(() => chain([])) };
    tagService = {
      normalizeHashtags: vi.fn((tags: string[]) => Promise.resolve(tags)),
      recordUsage: vi.fn(),
    };
    companyPages = { getMine: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }) };
    network = { listConnections: vi.fn().mockResolvedValue([]) };
    userBlock = { find: vi.fn(() => chain([])) };
    media = {
      assertOwnedMedia: vi.fn().mockResolvedValue(undefined),
      getServerAudioDurationByUrl: vi.fn().mockResolvedValue(null),
      getServerVideoDurationByUrl: vi.fn().mockResolvedValue(null),
    };
    // No tags by default; the mention test overrides resolveForWrite per case.
    mentionService = {
      resolveForWrite: vi.fn().mockResolvedValue({ stored: [], recipientUserIds: [] }),
    };
  });

  it('createPost resolves tags through MentionService and stores the returned mentions', async () => {
    const refId = new Types.ObjectId();
    const stored = [{ type: 'profile', refId, display: 'X', href: '/connect/u/x' }];
    mentionService.resolveForWrite = vi
      .fn()
      .mockResolvedValue({ stored, recipientUserIds: [new Types.ObjectId().toHexString()] });

    await build().createPost(authorId, {
      kind: 'text',
      body: 'hi @X',
      mentions: [{ type: 'profile', refId: refId.toHexString(), display: 'X' }],
    });

    // The picker's raw tags + the body + the post visibility were handed to the resolver.
    expect(mentionService.resolveForWrite).toHaveBeenCalledWith(
      expect.anything(),
      'hi @X',
      [{ type: 'profile', refId: refId.toHexString(), display: 'X' }],
      'public',
    );
    // The STORED (href-computed) mentions are persisted onto the post.
    const created = postModel.create.mock.calls[0][0];
    expect(created.mentions).toEqual(stored);
    // The tagged recipient gets a "you were tagged" alert (best-effort).
    const mentionDispatch = notifications.dispatch.mock.calls.find(
      (c: any[]) => c[0].category === 'connect.post_mentioned',
    );
    expect(mentionDispatch).toBeDefined();
  });

  it('createPost persists an empty mentions array when no tags are sent', async () => {
    await build().createPost(authorId, { kind: 'text', body: 'no tags here' });
    const created = postModel.create.mock.calls[0][0];
    expect(created.mentions).toEqual([]);
    expect(mentionService.resolveForWrite).toHaveBeenCalled();
  });

  it('createPost passes a connections-only visibility through to the tag reach gate', async () => {
    await build().createPost(authorId, {
      kind: 'text',
      body: 'friends only @X',
      visibility: 'connections',
      mentions: [{ type: 'profile', refId: new Types.ObjectId().toHexString(), display: 'X' }],
    });
    expect(mentionService.resolveForWrite).toHaveBeenCalledWith(
      expect.anything(),
      'friends only @X',
      expect.anything(),
      'connections',
    );
  });
});
