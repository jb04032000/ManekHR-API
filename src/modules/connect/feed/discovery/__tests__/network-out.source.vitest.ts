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
import { NetworkOutSource } from '../network-out.source';

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

describe('NetworkOutSource (Phase 7c)', () => {
  let edgeModel: any;
  let postModel: any;
  let networkService: any;
  const now = Date.now();
  const viewer = new Types.ObjectId();

  function build() {
    return new NetworkOutSource(edgeModel, postModel, networkService);
  }
  beforeEach(() => {
    edgeModel = { find: vi.fn(() => chain([])) };
    postModel = { find: vi.fn(() => chain([])) };
    networkService = { listFollowing: vi.fn().mockResolvedValue([]) };
  });

  it('returns nothing — and runs no edge query — when the viewer follows no one', async () => {
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(out).toEqual([]);
    expect(edgeModel.find).not.toHaveBeenCalled();
  });

  it('queries edges by the viewer followees, excluding the viewer as author', async () => {
    const f1 = new Types.ObjectId();
    const f2 = new Types.ObjectId();
    networkService.listFollowing = vi
      .fn()
      .mockResolvedValue([{ followeeId: f1 }, { followeeId: f2 }]);
    await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    const filter = edgeModel.find.mock.calls[0][0];
    expect(filter.actorId).toEqual({ $in: [f1, f2] });
    expect(filter.authorId).toEqual({ $ne: viewer });
  });

  it('ranks a post engaged by more followees above one engaged by fewer', async () => {
    networkService.listFollowing = vi
      .fn()
      .mockResolvedValue([{ followeeId: new Types.ObjectId() }]);
    const popular = new Types.ObjectId();
    const niche = new Types.ObjectId();
    edgeModel.find = vi.fn(() =>
      chain([
        { postId: popular, createdAt: new Date(now) },
        { postId: popular, createdAt: new Date(now) },
        { postId: niche, createdAt: new Date(now) },
      ]),
    );
    postModel.find = vi.fn(() => chain([{ _id: niche }, { _id: popular }]));
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(String(out[0].post._id)).toBe(String(popular));
    expect(out[0].origin).toBe('network_out');
  });

  it('drops posts absent from the post load (private / deleted since engagement)', async () => {
    networkService.listFollowing = vi
      .fn()
      .mockResolvedValue([{ followeeId: new Types.ObjectId() }]);
    const live = new Types.ObjectId();
    const gone = new Types.ObjectId();
    edgeModel.find = vi.fn(() =>
      chain([
        { postId: live, createdAt: new Date(now) },
        { postId: gone, createdAt: new Date(now) },
      ]),
    );
    postModel.find = vi.fn(() => chain([{ _id: live }])); // `gone` filtered by visibility/deleted
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(out.map((c) => String(c.post._id))).toEqual([String(live)]);
  });
});
