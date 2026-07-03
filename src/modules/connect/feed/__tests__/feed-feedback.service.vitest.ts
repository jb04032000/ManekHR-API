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
import { FeedService } from '../feed.service';
import { MUTE_DURATION_DAYS } from '../feed-feedback';

/**
 * Reader-feedback store + scoring inputs (Phase 7d). Covers the NEW behaviour
 * layered onto `FeedService`: mute expiry, not-interested author derivation,
 * idempotent undo, the hard-exclude vs dampen split, and the dampening maps the
 * For-You ranker consumes. Models are mocked — no Mongo.
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

describe('FeedService — reader feedback (Phase 7d)', () => {
  let postModel: any;
  let negativeModel: any;
  const viewer = new Types.ObjectId();

  /** Build a FeedService with only the models the feedback methods touch. */
  function build() {
    return new FeedService(
      postModel, // postModel (idx 0)
      {} as any, // feedEntry
      {} as any, // reaction
      {} as any, // queue
      {} as any, // profileService
      {} as any, // erpLink
      {} as any, // ranker
      {} as any, // discovery
      negativeModel, // negative (idx 8)
      {} as any, // engagementEdge
      {} as any, // seenPost
      {} as any, // savedPost
      {} as any, // notifications
      {} as any, // eventEmitter
      {} as any, // comment
      {} as any, // tagService
      {} as any, // companyPages
      {} as any, // network
      {} as any, // userBlock
      {} as any, // media
    );
  }

  beforeEach(() => {
    postModel = { find: vi.fn(() => chain([])), findOne: vi.fn(() => chain(null)) };
    negativeModel = {
      find: vi.fn(() => chain([])),
      updateOne: vi.fn(() => chain({})),
      deleteOne: vi.fn(() => chain({})),
    };
  });

  describe('addNegativeSignal', () => {
    it('stamps a mute with an expiry ~30 days out', async () => {
      const author = new Types.ObjectId();
      const before = Date.now();
      await build().addNegativeSignal(viewer, 'mute_author', String(author));
      const arg = negativeModel.updateOne.mock.calls[0][1];
      const set = arg.$set ?? arg.$setOnInsert ?? {};
      const expiresAt: Date = set.expiresAt;
      expect(expiresAt).toBeInstanceOf(Date);
      const expectedMs = MUTE_DURATION_DAYS * 24 * 60 * 60 * 1000;
      expect(expiresAt.getTime() - before).toBeGreaterThan(expectedMs - 5000);
      expect(expiresAt.getTime() - before).toBeLessThan(expectedMs + 60_000);
    });

    it('hide_post stores no expiry (persists)', async () => {
      const postId = new Types.ObjectId();
      await build().addNegativeSignal(viewer, 'hide_post', String(postId));
      const arg = negativeModel.updateOne.mock.calls[0][1];
      const merged = { ...(arg.$setOnInsert ?? {}), ...(arg.$set ?? {}) };
      expect(merged.expiresAt ?? null).toBeNull();
    });

    it('derives a not-interested-author once 3 of one author`s posts are marked', async () => {
      const author = new Types.ObjectId();
      const postId = new Types.ObjectId();
      // The marked post resolves to `author`.
      postModel.findOne = vi.fn(() => chain({ _id: postId, authorId: author }));
      // Viewer already has 3 not-interested marks, all on this author's posts.
      const marks = [new Types.ObjectId(), new Types.ObjectId(), postId].map((id) => ({
        targetId: id,
      }));
      negativeModel.find = vi.fn(() => chain(marks));
      postModel.find = vi.fn(() =>
        chain(marks.map((m) => ({ _id: m.targetId, authorId: author }))),
      );

      await build().addNegativeSignal(viewer, 'not_interested', String(postId));

      // One of the upserts targets the derived author kind.
      const derived = negativeModel.updateOne.mock.calls.find((c: any[]) =>
        JSON.stringify(c[0]).includes('not_interested_author'),
      );
      expect(derived).toBeDefined();
    });

    it('does NOT derive an author dampen below the threshold (1 mark)', async () => {
      const author = new Types.ObjectId();
      const postId = new Types.ObjectId();
      postModel.findOne = vi.fn(() => chain({ _id: postId, authorId: author }));
      negativeModel.find = vi.fn(() => chain([{ targetId: postId }]));
      postModel.find = vi.fn(() => chain([{ _id: postId, authorId: author }]));

      await build().addNegativeSignal(viewer, 'not_interested', String(postId));

      const derived = negativeModel.updateOne.mock.calls.find((c: any[]) =>
        JSON.stringify(c[0]).includes('not_interested_author'),
      );
      expect(derived).toBeUndefined();
    });
  });

  describe('removeNegativeSignal (undo)', () => {
    it('deletes the matching signal row', async () => {
      const postId = new Types.ObjectId();
      await build().removeNegativeSignal(viewer, 'hide_post', String(postId));
      expect(negativeModel.deleteOne).toHaveBeenCalledTimes(1);
      const filter = negativeModel.deleteOne.mock.calls[0][0];
      expect(filter.kind).toBe('hide_post');
      expect(String(filter.targetId)).toBe(String(postId));
    });

    it('is idempotent — undoing a non-existent signal does not throw', async () => {
      negativeModel.deleteOne = vi.fn(() => chain({ deletedCount: 0 }));
      const postId = new Types.ObjectId();
      await expect(
        build().removeNegativeSignal(viewer, 'not_interested', String(postId)),
      ).resolves.not.toThrow();
    });
  });

  // `loadNegativeSignals` replaced the separate `getNegativeFilter` (hide/mute)
  // + `buildDampening` (not-interested) reads with ONE per-page read that returns
  // all four buckets; these cases assert the same split behaviour on it.
  describe('loadNegativeSignals — hard exclusion (hide + not-interested + active mute)', () => {
    it('excludes hidden posts, not-interested posts, and active mutes', async () => {
      const hiddenPost = new Types.ObjectId();
      const mutedAuthor = new Types.ObjectId();
      const notInterestedPost = new Types.ObjectId();
      negativeModel.find = vi.fn(() =>
        chain([
          { kind: 'hide_post', targetId: hiddenPost, expiresAt: null },
          { kind: 'mute_author', targetId: mutedAuthor, expiresAt: null },
          { kind: 'not_interested', targetId: notInterestedPost, expiresAt: null },
        ]),
      );
      const filter = await (build() as any).loadNegativeSignals(viewer);
      expect(filter.hiddenPostIds.has(String(hiddenPost))).toBe(true);
      expect(filter.mutedAuthorIds.has(String(mutedAuthor))).toBe(true);
      // not-interested now ALSO hard-excludes the post (alongside its For-You dampen).
      expect(filter.hiddenPostIds.has(String(notInterestedPost))).toBe(true);
    });

    it('ignores an EXPIRED mute (TTL may lag — read filters it too)', async () => {
      const mutedAuthor = new Types.ObjectId();
      negativeModel.find = vi.fn(() =>
        chain([
          { kind: 'mute_author', targetId: mutedAuthor, expiresAt: new Date(Date.now() - 1000) },
        ]),
      );
      const filter = await (build() as any).loadNegativeSignals(viewer);
      expect(filter.mutedAuthorIds.has(String(mutedAuthor))).toBe(false);
    });
  });

  describe('loadNegativeSignals — For-You score multipliers', () => {
    it('produces a (0,1] factor for a not-interested post and a derived author', async () => {
      const postId = new Types.ObjectId();
      const author = new Types.ObjectId();
      negativeModel.find = vi.fn(() =>
        chain([
          { kind: 'not_interested', targetId: postId, createdAt: new Date() },
          { kind: 'not_interested_author', targetId: author, createdAt: new Date() },
        ]),
      );
      const { dampenByPost, dampenByAuthor } = await (build() as any).loadNegativeSignals(viewer);
      const pf = dampenByPost.get(String(postId));
      const af = dampenByAuthor.get(String(author));
      expect(pf).toBeGreaterThan(0);
      expect(pf).toBeLessThanOrEqual(1);
      expect(af).toBeGreaterThan(0);
      expect(af).toBeLessThanOrEqual(1);
      // The author dampen is stronger (lower multiplier) than a single post mark.
      expect(af).toBeLessThan(pf);
    });
  });
});
