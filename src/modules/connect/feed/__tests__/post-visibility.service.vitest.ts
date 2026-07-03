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
import { PostVisibilityService } from '../post-visibility.service';

/**
 * Unit coverage for shared abstraction #1 (feed harden Bucket 1) — the single
 * can-view/engage gate. Models + network are mocked. Verifies the four rules:
 * soft-delete, own-post carve-out, block-either-direction, connections-only.
 */

function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

describe('PostVisibilityService — can-view/engage gate (Bucket 1)', () => {
  let postModel: any;
  let userBlockModel: any;
  let network: any;
  const viewer = new Types.ObjectId();
  const author = new Types.ObjectId();

  function build() {
    return new PostVisibilityService(postModel, userBlockModel, network);
  }

  function post(
    overrides: Partial<{ visibility: 'public' | 'connections'; deletedAt: Date | null }>,
  ) {
    return {
      _id: new Types.ObjectId(),
      authorId: author,
      visibility: 'public' as const,
      deletedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    postModel = { findOne: vi.fn(() => chain(null)) };
    // No block by default; exists() returns null (no matching block row).
    userBlockModel = {
      exists: vi.fn(() => chain(null)),
      find: vi.fn(() => chain([])),
    };
    // No connections by default.
    network = { listConnections: vi.fn().mockResolvedValue([]) };
  });

  it('denies a soft-deleted post to everyone (before any block/connection read)', async () => {
    const ok = await build().canViewPost(viewer, post({ deletedAt: new Date() }));
    expect(ok).toBe(false);
    // No block/connection reads needed once deleted short-circuits.
    expect(userBlockModel.exists).not.toHaveBeenCalled();
    expect(network.listConnections).not.toHaveBeenCalled();
  });

  it('always shows a viewer their OWN post regardless of visibility', async () => {
    const ownConnectionsOnly = {
      _id: new Types.ObjectId(),
      authorId: viewer,
      visibility: 'connections' as const,
      deletedAt: null,
    };
    const ok = await build().canViewPost(viewer, ownConnectionsOnly);
    expect(ok).toBe(true);
    expect(userBlockModel.exists).not.toHaveBeenCalled();
  });

  it('denies a public post when a block exists in either direction', async () => {
    userBlockModel.exists = vi.fn(() => chain({ _id: new Types.ObjectId() }));
    const ok = await build().canViewPost(viewer, post({ visibility: 'public' }));
    expect(ok).toBe(false);
  });

  it('denies a connections-only post to a non-connection stranger', async () => {
    network.listConnections = vi.fn().mockResolvedValue([]); // viewer not connected
    const ok = await build().canViewPost(viewer, post({ visibility: 'connections' }));
    expect(ok).toBe(false);
  });

  it('allows a connections-only post to a connection of the author', async () => {
    // author's connections include the viewer.
    network.listConnections = vi.fn().mockResolvedValue([{ userId: String(viewer) }]);
    const ok = await build().canViewPost(viewer, post({ visibility: 'connections' }));
    expect(ok).toBe(true);
  });

  it('canEngagePost mirrors canViewPost (denies a blocked user)', async () => {
    userBlockModel.exists = vi.fn(() => chain({ _id: new Types.ObjectId() }));
    const ok = await build().canEngagePost(viewer, post({ visibility: 'public' }));
    expect(ok).toBe(false);
  });

  it('filterViewable drops deleted + blocked + non-connection connections-only in one pass', async () => {
    const blockedAuthor = new Types.ObjectId();
    userBlockModel.find = vi.fn(() =>
      chain([{ blockerUserId: viewer, blockedUserId: blockedAuthor }]),
    );
    network.listConnections = vi.fn().mockResolvedValue([]); // no connections
    const posts = [
      {
        _id: new Types.ObjectId(),
        authorId: author,
        visibility: 'public' as const,
        deletedAt: null,
      },
      {
        _id: new Types.ObjectId(),
        authorId: author,
        visibility: 'public' as const,
        deletedAt: new Date(),
      },
      {
        _id: new Types.ObjectId(),
        authorId: blockedAuthor,
        visibility: 'public' as const,
        deletedAt: null,
      },
      {
        _id: new Types.ObjectId(),
        authorId: author,
        visibility: 'connections' as const,
        deletedAt: null,
      },
    ];
    const out = await build().filterViewable(viewer, posts);
    // Only the first (live, public, non-blocked) survives.
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(posts[0]);
  });

  it('canWatchPostId returns false for a missing/deleted post (never confirms existence)', async () => {
    postModel.findOne = vi.fn(() => chain(null));
    const ok = await build().canWatchPostId(viewer, new Types.ObjectId().toHexString());
    expect(ok).toBe(false);
  });

  it('canWatchPostId returns false for a non-ObjectId string', async () => {
    const ok = await build().canWatchPostId(viewer, 'not-an-id');
    expect(ok).toBe(false);
    expect(postModel.findOne).not.toHaveBeenCalled();
  });
});
