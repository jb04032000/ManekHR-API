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
import { TrendingSource } from '../trending.source';

function findChain(result: unknown) {
  const c: any = {
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

function post(over: any = {}) {
  return {
    _id: new Types.ObjectId(),
    authorId: new Types.ObjectId(),
    reactionCount: 0,
    commentCount: 0,
    authorErpLinked: false,
    createdAt: new Date(),
    ...over,
  };
}

describe('TrendingSource (Phase 7c)', () => {
  let postModel: any;
  let trendingModel: any;
  const now = Date.now();
  const viewer = new Types.ObjectId();

  function build() {
    return new TrendingSource(postModel, trendingModel);
  }
  beforeEach(() => {
    postModel = { find: vi.fn(() => findChain([])) };
    // Materialized set empty by default -> the live-scan fallback path runs, so
    // the existing scan assertions hold.
    trendingModel = { find: vi.fn(() => findChain([])) };
  });

  it('scopes the query to recent public posts excluding the viewer', async () => {
    await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    const filter = postModel.find.mock.calls[0][0];
    expect(filter.deletedAt).toBeNull();
    expect(filter.visibility).toBe('public');
    expect(filter.authorId).toEqual({ $ne: viewer });
    expect(filter.createdAt.$gte).toBeInstanceOf(Date);
  });

  it('ranks a more-engaged post above a fresh zero-engagement one', async () => {
    const hot = post({ reactionCount: 50, commentCount: 10, createdAt: new Date(now - 3_600_000) });
    const cold = post({ reactionCount: 0, commentCount: 0, createdAt: new Date(now) });
    postModel.find = vi.fn(() => findChain([cold, hot]));
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(String(out[0].post._id)).toBe(String(hot._id));
    expect(out[0].origin).toBe('trending');
  });

  it('still surfaces a recent zero-engagement post (cold-start floor)', async () => {
    const fresh = post({ createdAt: new Date(now) });
    postModel.find = vi.fn(() => findChain([fresh]));
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(out).toHaveLength(1);
    expect(out[0].sourceScore).toBeGreaterThan(0);
  });

  it('caps to the requested limit', async () => {
    postModel.find = vi.fn(() => findChain([post(), post(), post()]));
    const out = await build().fetch({ viewerId: viewer, now, limit: 2, viewerSkills: [] });
    expect(out).toHaveLength(2);
  });

  it('reads the materialized trending set when present, by id (B2)', async () => {
    const p = post();
    trendingModel.find = vi.fn(() => findChain([{ postId: p._id }]));
    postModel.find = vi.fn(() => findChain([p]));
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    // The post fetch is keyed on the materialized id set, not a window scan.
    const filter = postModel.find.mock.calls[0][0];
    expect(filter._id).toEqual({ $in: [p._id] });
    expect(filter.createdAt).toBeUndefined();
    expect(String(out[0].post._id)).toBe(String(p._id));
  });
});
