/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing the service so the transitive schema
// imports do not trip SchemaFactory's reflection. Mirrors
// `connect/network/__tests__/network.service.vitest.ts`.
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
import { NotFoundException } from '@nestjs/common';
import { ReactionService } from '../reaction.service';

/**
 * Unit coverage for `ReactionService` (Phase 3 — Feed). Verifies the like
 * toggle is idempotent, keeps the post tally in step, and emits live
 * `post:activity` only on a real change. Models + gateway are mocked — no Mongo.
 */

/** A Mongoose query chain whose `.exec()` resolves `result`. */
function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

describe('ReactionService — feed reactions (Phase 3)', () => {
  let reactionModel: any;
  let postModel: any;
  let engagementEdgeModel: any;
  let gateway: any;
  const postId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId();

  function build() {
    // Phase 7a — NotificationsService injected. Phase 7c — EngagementEdge model
    // injected as the 3rd arg. Stubs swallow dispatch + edge writes so the
    // existing assertions stay focused on reaction tally + gateway emit.
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    return new ReactionService(
      reactionModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
    );
  }

  /** Bucket-1 gate variant: inject a stub PostVisibilityService (6th arg). */
  function buildGated(canEngage: boolean) {
    const notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    const postVisibility = {
      canEngagePost: vi.fn().mockResolvedValue(canEngage),
    } as any;
    return new ReactionService(
      reactionModel,
      postModel,
      engagementEdgeModel,
      gateway,
      notifications,
      postVisibility,
    );
  }

  beforeEach(() => {
    reactionModel = {
      updateOne: vi.fn(() => chain({ upsertedCount: 1 })),
      deleteOne: vi.fn(() => chain({ deletedCount: 1 })),
    };
    postModel = {
      findOne: vi.fn(() =>
        chain({ _id: new Types.ObjectId(postId), reactionCount: 3, commentCount: 1 }),
      ),
      findByIdAndUpdate: vi.fn(() => chain({ reactionCount: 4 })),
      updateOne: vi.fn(() => chain({})),
    };
    engagementEdgeModel = {
      updateOne: vi.fn(() => chain({})),
      deleteOne: vi.fn(() => chain({})),
    };
    gateway = { emitPostActivity: vi.fn(), emitNewPost: vi.fn() };
  });

  it('404s when reacting to a missing post', async () => {
    postModel.findOne = vi.fn(() => chain(null));
    await expect(build().react(userId, postId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('CN-FEED-4: 404s (never 403) when the viewer cannot engage the post', async () => {
    // Post exists, but the shared gate denies (blocked / connections-only) →
    // 404 so a hidden post is never confirmed, and no write lands.
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(),
        visibility: 'connections',
      }),
    );
    await expect(buildGated(false).react(userId, postId)).rejects.toBeInstanceOf(NotFoundException);
    expect(reactionModel.updateOne).not.toHaveBeenCalled();
  });

  it('CN-FEED-4: allows the react when the gate permits it', async () => {
    postModel.findOne = vi.fn(() =>
      chain({
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(),
        visibility: 'public',
        reactionCount: 3,
        commentCount: 1,
      }),
    );
    const res = await buildGated(true).react(userId, postId);
    expect(res.reacted).toBe(true);
    expect(reactionModel.updateOne).toHaveBeenCalled();
  });

  it('react adds the like, bumps the tally, and emits live activity', async () => {
    const res = await build().react(userId, postId);
    expect(res).toEqual({ reacted: true, reactionCount: 4 });
    expect(gateway.emitPostActivity).toHaveBeenCalledWith(
      expect.objectContaining({ postId, reactionCount: 4 }),
    );
    // Unified engagement edge upserted (network-out discovery + analytics).
    expect(engagementEdgeModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'react' }),
      expect.anything(),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('react is idempotent — a repeat tap neither re-counts nor re-emits', async () => {
    reactionModel.updateOne = vi.fn(() => chain({ upsertedCount: 0 }));
    const res = await build().react(userId, postId);
    expect(res.reactionCount).toBe(3);
    expect(postModel.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(gateway.emitPostActivity).not.toHaveBeenCalled();
    expect(engagementEdgeModel.updateOne).not.toHaveBeenCalled();
  });

  it('unreact removes the like and emits the lowered count', async () => {
    postModel.findByIdAndUpdate = vi.fn(() => chain({ reactionCount: 2 }));
    const res = await build().unreact(userId, postId);
    expect(res).toEqual({ reacted: false, reactionCount: 2 });
    expect(gateway.emitPostActivity).toHaveBeenCalled();
    expect(engagementEdgeModel.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'react' }),
    );
  });

  it('unreact tolerates a missing reaction — no emit', async () => {
    reactionModel.deleteOne = vi.fn(() => chain({ deletedCount: 0 }));
    const res = await build().unreact(userId, postId);
    expect(res.reacted).toBe(false);
    expect(gateway.emitPostActivity).not.toHaveBeenCalled();
  });
});
