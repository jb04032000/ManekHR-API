/* eslint-disable @typescript-eslint/no-explicit-any */
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
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { CommentService } from '../comment.service';
import { encodeCursor } from '../../common/keyset-cursor';
import { COMMENT_RATE_LIMIT_DAY, COMMENT_RATE_LIMIT_SHORT } from '../feed.constants';

/**
 * Unit coverage for `CommentService` (Phase 3 — Feed). Verifies the post guard,
 * the one-level reply rule (no reply-to-a-reply), the comment-count `$inc`, and
 * delete-own-only authorization. Models + gateway are mocked — no Mongo.
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

describe('CommentService — feed comments (Phase 3)', () => {
  let commentModel: any;
  let postModel: any;
  let engagementEdgeModel: any;
  let gateway: any;
  const postId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId();

  function build() {
    // Phase 7a — NotificationsService injected. Phase 7c — EngagementEdge model
    // injected as the 3rd arg. Stubs swallow dispatch + edge writes.
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    // @mentions resolver (Task 1.5) - last positional arg. Default: no tags.
    const mentions = {
      resolveForWrite: vi.fn(() => Promise.resolve({ stored: [], recipientUserIds: [] })),
    } as any;
    return new CommentService(
      commentModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      mentions,
    );
  }

  /** Bucket-1 gate variant: inject a stub PostVisibilityService (7th arg). */
  function buildGated(opts: { canEngage?: boolean; canView?: boolean }) {
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    const mentions = {
      resolveForWrite: vi.fn(() => Promise.resolve({ stored: [], recipientUserIds: [] })),
    } as any;
    const postVisibility = {
      canEngagePost: vi.fn().mockResolvedValue(opts.canEngage ?? true),
      canViewPost: vi.fn().mockResolvedValue(opts.canView ?? true),
    } as any;
    return new CommentService(
      commentModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      mentions,
      postVisibility,
    );
  }

  beforeEach(() => {
    commentModel = {
      findOne: vi.fn(() => chain(null)),
      findById: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([])),
      // Anti-spam: rate-limit counts default to 0 (under the cap) so the happy
      // path writes; duplicate-lookback `find` defaults to [] (no prior dup).
      countDocuments: vi.fn(() => chain(0)),
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    engagementEdgeModel = { updateOne: vi.fn(() => chain({})) };
    postModel = {
      findOne: vi.fn(() =>
        chain({ _id: new Types.ObjectId(postId), reactionCount: 2, commentCount: 4 }),
      ),
      findById: vi.fn(() =>
        chain({ _id: new Types.ObjectId(postId), reactionCount: 2, commentCount: 3 }),
      ),
      updateOne: vi.fn(() => chain({})),
    };
    gateway = { emitPostActivity: vi.fn(), emitNewPost: vi.fn() };
  });

  it('404s when commenting on a missing post', async () => {
    postModel.findOne = vi.fn(() => chain(null));
    await expect(build().addComment(userId, postId, 'Nice')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('adds a top-level comment, bumps the count, and emits live activity', async () => {
    await build().addComment(userId, postId, '  Beautiful work  ');
    expect(commentModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Beautiful work', parentId: null }),
    );
    expect(postModel.updateOne).toHaveBeenCalled();
    expect(gateway.emitPostActivity).toHaveBeenCalled();
    // Unified engagement edge upserted (the "commented on" signal).
    expect(engagementEdgeModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'comment' }),
      expect.anything(),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('refuses a reply to a reply — threading is one level deep', async () => {
    const parentId = new Types.ObjectId();
    // The "parent" is itself a reply (its own parentId is set) → reject.
    commentModel.findOne = vi.fn(() =>
      chain({ postId: new Types.ObjectId(postId), parentId: new Types.ObjectId() }),
    );
    await expect(
      build().addComment(userId, postId, 'Reply', parentId.toHexString()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists a page of a post comment thread (keyset envelope: items + nextCursor)', async () => {
    const top = { _id: new Types.ObjectId(), body: 'Hi', parentId: null, createdAt: new Date() };
    // First find = top-level window; second find = replies for that page.
    commentModel.find = vi
      .fn()
      .mockReturnValueOnce(chain([top]))
      .mockReturnValueOnce(chain([]));
    // Bucket-1 signature: listComments now takes a viewer id (2nd arg). The
    // default build() has no injected visibility gate, so the read runs
    // ungated here (the gate itself is covered by post-visibility.service.vitest).
    const page = await build().listComments(postId, userId.toHexString());
    expect(page.items).toHaveLength(1);
    // Window not full (1 < 20) -> caught up, no further page.
    expect(page.nextCursor).toBeNull();
  });

  it('clamps an over-large limit to the 50 max before querying', async () => {
    const c = chain([]); // empty top window -> replies query skipped
    commentModel.find = vi.fn(() => c);
    await build().listComments(postId, userId.toHexString(), { limit: 500 });
    // Over-fetch is limit+1, so the clamp (50) means the query asks for 51.
    expect(c.limit).toHaveBeenCalledWith(51);
  });

  it('emits a nextCursor when the window is full (more comments remain)', async () => {
    // 21 rows for a default page of 20 -> hasMore, cursor = the 20th row.
    const rows = Array.from({ length: 21 }, (_, i) => ({
      _id: new Types.ObjectId(),
      body: `c${i}`,
      parentId: null,
      createdAt: new Date(2026, 0, 21 - i),
    }));
    commentModel.find = vi
      .fn()
      .mockReturnValueOnce(chain(rows)) // top-level window (limit+1 = 21)
      .mockReturnValueOnce(chain([])); // replies
    const page = await build().listComments(postId, userId.toHexString());
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(encodeCursor(rows[19]));
  });

  it('applies the keyset cursor as a strictly-older filter', async () => {
    const cursor = encodeCursor({ _id: new Types.ObjectId(), createdAt: new Date('2026-06-11') });
    commentModel.find = vi.fn(() => chain([]));
    await build().listComments(postId, userId.toHexString(), { cursor });
    const filterArg = commentModel.find.mock.calls[0][0];
    expect(filterArg.$or).toBeDefined();
    expect(filterArg.parentId).toBeNull();
  });

  it('refuses deleting another member comment', async () => {
    commentModel.findById = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(),
        authorId: new Types.ObjectId(), // a different author
        deletedAt: null,
        postId: new Types.ObjectId(postId),
        save: vi.fn(),
      }),
    );
    await expect(
      build().deleteComment(userId, new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('notifies the parent comment author on a reply (skip post-author double-ping)', async () => {
    const parentId = new Types.ObjectId();
    const parentAuthorId = new Types.ObjectId();
    const reactPostId = new Types.ObjectId(postId);
    // Post author, parent comment author, and replier are all distinct.
    postModel.findOne = vi.fn(() =>
      chain({
        _id: reactPostId,
        authorId: new Types.ObjectId(),
        reactionCount: 0,
        commentCount: 0,
      }),
    );
    // The parent is a top-level comment (parentId null) by `parentAuthorId`.
    commentModel.findOne = vi.fn(() =>
      chain({ postId: reactPostId, parentId: null, authorId: parentAuthorId }),
    );
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    const mentions = {
      resolveForWrite: vi.fn(() => Promise.resolve({ stored: [], recipientUserIds: [] })),
    } as any;
    const service = new CommentService(
      commentModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      mentions,
    );
    await service.addComment(userId, postId, 'Great point', parentId.toHexString());
    // A `post_replied` notification went to the parent comment author.
    expect(notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'connect.post_replied',
        recipientId: parentAuthorId,
      }),
    );
  });

  it('does not notify on a self-reply (replying to your own comment)', async () => {
    const parentId = new Types.ObjectId();
    const reactPostId = new Types.ObjectId(postId);
    postModel.findOne = vi.fn(() =>
      chain({
        _id: reactPostId,
        authorId: new Types.ObjectId(),
        reactionCount: 0,
        commentCount: 0,
      }),
    );
    // Parent comment authored by the SAME user who is now replying.
    commentModel.findOne = vi.fn(() =>
      chain({ postId: reactPostId, parentId: null, authorId: userId }),
    );
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    const mentions = {
      resolveForWrite: vi.fn(() => Promise.resolve({ stored: [], recipientUserIds: [] })),
    } as any;
    const service = new CommentService(
      commentModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      mentions,
    );
    await service.addComment(userId, postId, 'Following up myself', parentId.toHexString());
    const categories = notifications.dispatch.mock.calls.map((c: any[]) => c[0].category);
    expect(categories).not.toContain('connect.post_replied');
  });

  it('stores resolved @mentions on the comment and notifies each tagged recipient', async () => {
    const postAuthor = new Types.ObjectId();
    const taggedUser = new Types.ObjectId().toHexString();
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: postAuthor,
        visibility: 'public',
        reactionCount: 0,
        commentCount: 0,
      }),
    );
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    const mentions = {
      resolveForWrite: vi.fn(() =>
        Promise.resolve({
          stored: [
            { type: 'profile', refId: new Types.ObjectId(), display: 'X', href: '/connect/u/x' },
          ],
          recipientUserIds: [taggedUser],
        }),
      ),
    } as any;
    const service = new CommentService(
      commentModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      mentions,
    );
    await service.addComment(userId, postId, 'hi @X', undefined, [
      { type: 'profile', refId: taggedUser, display: 'X' } as any,
    ]);
    expect(commentModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: expect.arrayContaining([expect.objectContaining({ display: 'X' })]),
      }),
    );
    const mentionCall = notifications.dispatch.mock.calls.find(
      (c: any[]) => c[0].category === 'connect.post_mentioned',
    );
    expect(mentionCall).toBeDefined();
    expect(mentionCall[0].recipientId).toBe(taggedUser);
  });

  it('does not double-ping the post author via the @mention path', async () => {
    const postAuthor = new Types.ObjectId();
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: postAuthor,
        visibility: 'public',
        reactionCount: 0,
        commentCount: 0,
      }),
    );
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    const mentions = {
      resolveForWrite: vi.fn(() =>
        Promise.resolve({
          stored: [{ type: 'profile', refId: postAuthor, display: 'Author', href: '/connect/u/a' }],
          recipientUserIds: [String(postAuthor)],
        }),
      ),
    } as any;
    const service = new CommentService(
      commentModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      mentions,
    );
    await service.addComment(userId, postId, 'hi @Author', undefined, [
      { type: 'profile', refId: String(postAuthor), display: 'Author' } as any,
    ]);
    const mentionPings = notifications.dispatch.mock.calls.filter(
      (c: any[]) => c[0].category === 'connect.post_mentioned',
    );
    expect(mentionPings).toHaveLength(0);
  });

  // ── Per-(user,post) anti-spam (A + B) ──────────────────────────────────

  it('429s the 11th comment in the 10-min window on the same post', async () => {
    // The short-window count is already at the cap -> reject before writing.
    commentModel.countDocuments = vi.fn(() => chain(COMMENT_RATE_LIMIT_SHORT));
    const err = await build()
      .addComment(userId, postId, 'One more')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(commentModel.create).not.toHaveBeenCalled();
  });

  it('429s once past the daily cap even when the 10-min window is clear', async () => {
    // First count (short window) under cap, second count (day) at the cap.
    commentModel.countDocuments = vi
      .fn()
      .mockReturnValueOnce(chain(0))
      .mockReturnValueOnce(chain(COMMENT_RATE_LIMIT_DAY));
    const err = await build()
      .addComment(userId, postId, 'Daily flood')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(commentModel.create).not.toHaveBeenCalled();
  });

  it('counts the rate limit PER post — the cap query is scoped to this post', async () => {
    // Under the cap (default 0) -> the comment on this post still goes through,
    // and the count query is keyed by both authorId and this postId (so a
    // different post carries its own independent budget).
    await build().addComment(userId, postId, 'On this post');
    expect(commentModel.create).toHaveBeenCalled();
    const filterArg = commentModel.countDocuments.mock.calls[0][0];
    expect(filterArg.postId).toBeDefined();
    expect(filterArg.authorId).toBeDefined();
    expect(filterArg.createdAt.$gte).toBeInstanceOf(Date);
  });

  it('dedupes an identical body re-submitted within 30s (returns the existing comment)', async () => {
    const existing = {
      _id: new Types.ObjectId(),
      body: 'Hello world',
      parentId: null,
      createdAt: new Date(),
    };
    // The lookback finds the just-posted comment; spacing differs but normalizes
    // to the same string.
    commentModel.find = vi.fn(() => chain([existing]));
    const result = await build().addComment(userId, postId, '  Hello   world  ');
    expect(result).toBe(existing);
    expect(commentModel.create).not.toHaveBeenCalled();
  });

  it('accepts the same body once the 30s window has passed (no dup in range)', async () => {
    // The windowed lookback returns nothing (the prior row aged out of range) ->
    // the comment is written normally.
    commentModel.find = vi.fn(() => chain([]));
    await build().addComment(userId, postId, 'Hello world');
    expect(commentModel.create).toHaveBeenCalled();
    // The dup lookback is bounded to a recent window (createdAt >= since).
    const dupFilter = commentModel.find.mock.calls[0][0];
    expect(dupFilter.createdAt.$gte).toBeInstanceOf(Date);
  });

  // ── Bucket 1 visibility/engagement gate (CN-FEED-4 / CN-FEED-5) ─────────

  it('CN-FEED-4: 404s a comment write when the viewer cannot engage the post', async () => {
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(),
        visibility: 'connections',
        reactionCount: 0,
        commentCount: 0,
      }),
    );
    await expect(
      buildGated({ canEngage: false }).addComment(userId, postId, 'Hi'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(commentModel.create).not.toHaveBeenCalled();
  });

  it('CN-FEED-5: 404s a comment-thread read when the viewer cannot see the post', async () => {
    // The gate's canViewPost denies; listComments loads the post then 404s
    // before paginating (never confirms a hidden post's existence).
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(),
        visibility: 'connections',
      }),
    );
    await expect(
      buildGated({ canView: false }).listComments(postId, userId.toHexString()),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The comment window query never ran (we 404'd on the post gate first).
    expect(commentModel.find).not.toHaveBeenCalled();
  });

  it('CN-FEED-5: allows the thread read when the viewer can see the post', async () => {
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(),
        visibility: 'public',
      }),
    );
    commentModel.find = vi.fn(() => chain([]));
    const page = await buildGated({ canView: true }).listComments(postId, userId.toHexString());
    expect(page.items).toEqual([]);
  });

  // ── Bucket 6 moderation takedown (CN-MOD-2) ─────────────────────────────

  it('CN-MOD-2: a comment takedown event soft-deletes the comment + decrements the count', async () => {
    const commentDoc: any = {
      _id: new Types.ObjectId(),
      postId: new Types.ObjectId(postId),
      deletedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    commentModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(commentDoc) }));
    postModel.findById = vi.fn(() =>
      chain({ _id: new Types.ObjectId(postId), reactionCount: 0, commentCount: 2 }),
    );
    await build().onContentTakedown({
      targetType: 'comment',
      targetId: commentDoc._id.toHexString(),
      actorId: new Types.ObjectId().toHexString(),
    });
    expect(commentDoc.deletedAt).toBeInstanceOf(Date);
    expect(commentDoc.save).toHaveBeenCalled();
    expect(postModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ commentCount: { $gt: 0 } }),
      expect.objectContaining({ $inc: { commentCount: -1 } }),
    );
    expect(gateway.emitPostActivity).toHaveBeenCalled();
  });

  it('CN-MOD-2: ignores a takedown event for a non-comment target type', async () => {
    commentModel.findById = vi.fn(() => ({ exec: vi.fn() }));
    await build().onContentTakedown({
      targetType: 'post',
      targetId: new Types.ObjectId().toHexString(),
      actorId: new Types.ObjectId().toHexString(),
    });
    expect(commentModel.findById).not.toHaveBeenCalled();
  });
});
