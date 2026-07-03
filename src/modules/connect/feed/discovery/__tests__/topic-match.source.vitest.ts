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
import { TopicMatchSource } from '../topic-match.source';

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
    hashtags: [],
    authorSkills: [],
    reactionCount: 0,
    commentCount: 0,
    createdAt: new Date(),
    ...over,
  };
}

describe('TopicMatchSource (Phase 7c)', () => {
  let postModel: any;
  const now = Date.now();
  const viewer = new Types.ObjectId();

  function build() {
    return new TopicMatchSource(postModel);
  }
  beforeEach(() => {
    postModel = { find: vi.fn(() => findChain([])) };
  });

  it('returns nothing — and runs no query — when the viewer has no skills', async () => {
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: [] });
    expect(out).toEqual([]);
    expect(postModel.find).not.toHaveBeenCalled();
  });

  it('matches recent public posts on hashtag (lower-cased) OR authorSkill', async () => {
    await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: ['Zari', 'Aari'] });
    const filter = postModel.find.mock.calls[0][0];
    expect(filter.visibility).toBe('public');
    expect(filter.authorId).toEqual({ $ne: viewer });
    expect(filter.$or).toEqual([
      { hashtags: { $in: ['zari', 'aari'] } },
      { authorSkills: { $in: ['Zari', 'Aari'] } },
    ]);
  });

  it('scans WITHOUT the heavy inline media blob (projected out for perf)', async () => {
    await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: ['Zari'] });
    const chain = postModel.find.mock.results[0].value;
    // Ranking never reads `media`; excluding it keeps the candidate scan light
    // (media is re-hydrated for only the rendered page in feed.service.toPage).
    expect(chain.select).toHaveBeenCalledWith('-media');
  });

  it('ranks a higher-overlap post above a lower-overlap one', async () => {
    const two = post({ authorSkills: ['Zari', 'Aari'], createdAt: new Date(now) });
    const one = post({ authorSkills: ['Zari'], createdAt: new Date(now) });
    postModel.find = vi.fn(() => findChain([one, two]));
    const out = await build().fetch({
      viewerId: viewer,
      now,
      limit: 10,
      viewerSkills: ['Zari', 'Aari'],
    });
    expect(String(out[0].post._id)).toBe(String(two._id));
    expect(out[0].origin).toBe('topic');
  });

  it('scores a hashtag match (lower-cased) above zero', async () => {
    const p = post({ hashtags: ['zari'], createdAt: new Date(now) });
    postModel.find = vi.fn(() => findChain([p]));
    const out = await build().fetch({ viewerId: viewer, now, limit: 10, viewerSkills: ['Zari'] });
    expect(out).toHaveLength(1);
    expect(out[0].sourceScore).toBeGreaterThan(0);
  });
});
