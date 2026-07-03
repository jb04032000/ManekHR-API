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
import { GeoLocalSource } from '../geo-local.source';

function findChain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
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
    createdAt: new Date(),
    ...over,
  };
}

describe('GeoLocalSource (Phase 7c)', () => {
  let postModel: any;
  const now = Date.now();
  const viewer = new Types.ObjectId();

  function build() {
    return new GeoLocalSource(postModel);
  }
  beforeEach(() => {
    postModel = { find: vi.fn(() => findChain([])) };
  });

  it('returns nothing — and runs no query — when the viewer has no district', async () => {
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(out).toEqual([]);
    expect(postModel.find).not.toHaveBeenCalled();
  });

  it('matches recent public posts in the viewer district, excluding own', async () => {
    await build().fetch({
      viewerId: viewer,
      now,
      limit: 10,
      viewerSkills: [],
      viewerDistrict: 'Surat',
    });
    const filter = postModel.find.mock.calls[0][0];
    expect(filter.authorDistrict).toBe('Surat');
    expect(filter.visibility).toBe('public');
    expect(filter.authorId).toEqual({ $ne: viewer });
  });

  it('trims the viewer district before matching', async () => {
    await build().fetch({
      viewerId: viewer,
      now,
      limit: 10,
      viewerSkills: [],
      viewerDistrict: '  Jetpur  ',
    });
    expect(postModel.find.mock.calls[0][0].authorDistrict).toBe('Jetpur');
  });

  it('caps to the limit and tags origin geo', async () => {
    postModel.find = vi.fn(() => findChain([post(), post(), post()]));
    const out = await build().fetch({
      viewerId: viewer,
      now,
      limit: 2,
      viewerSkills: [],
      viewerDistrict: 'Surat',
    });
    expect(out).toHaveLength(2);
    expect(out[0].origin).toBe('geo');
  });
});
