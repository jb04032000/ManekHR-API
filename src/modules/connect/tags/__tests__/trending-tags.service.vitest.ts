/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports (ConnectTag, Post) do not trip vitest's
// reflect-metadata pipeline. The models are positional mocks.
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

import { TrendingTagsService } from '../trending-tags.service';

function build() {
  const postModel: any = { aggregate: vi.fn().mockResolvedValue([]) };
  const tagModel: any = {
    updateMany: vi.fn().mockResolvedValue({}),
    bulkWrite: vi.fn().mockResolvedValue({}),
  };
  const service = new TrendingTagsService(postModel, tagModel);
  return { service, postModel, tagModel };
}

describe('TrendingTagsService.recomputeTrending', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scores a tag spiking above its baseline; gates a low-volume tag', async () => {
    const f = build();
    // First aggregate call = current window, second = baseline window.
    f.postModel.aggregate = vi
      .fn()
      .mockResolvedValueOnce([
        { slug: 'zari', authorCount: 8 },
        { slug: 'rare', authorCount: 2 },
      ])
      .mockResolvedValueOnce([{ slug: 'zari', authorCount: 7 }]);

    const result = await f.service.recomputeTrending(new Date());

    // Stale scores are cleared first.
    expect(f.tagModel.updateMany).toHaveBeenCalledWith(
      { trendingScore: { $gt: 0 } },
      { $set: { trendingScore: 0 } },
    );

    expect(f.tagModel.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = f.tagModel.bulkWrite.mock.calls[0][0];
    const slugs = ops.map((op: any) => op.updateOne.filter.slug);
    expect(slugs).toContain('zari'); // spiked above baseline
    expect(slugs).not.toContain('rare'); // below the min-distinct-authors gate
    const zariOp = ops.find((op: any) => op.updateOne.filter.slug === 'zari');
    expect(zariOp.updateOne.update.$set.trendingScore).toBeGreaterThan(0);
    expect(result.trending).toBe(1);
  });

  it('does not trend a tag sitting at its steady baseline', async () => {
    const f = build();
    f.postModel.aggregate = vi
      .fn()
      .mockResolvedValueOnce([{ slug: 'common', authorCount: 10 }])
      .mockResolvedValueOnce([{ slug: 'common', authorCount: 70 }]); // 7d baseline => ~10 expected in 24h

    const result = await f.service.recomputeTrending(new Date());

    expect(f.tagModel.bulkWrite).not.toHaveBeenCalled();
    expect(result.trending).toBe(0);
  });

  it('clears stale scores even with no current activity', async () => {
    const f = build();
    f.postModel.aggregate = vi.fn().mockResolvedValue([]);

    await f.service.recomputeTrending(new Date());

    expect(f.tagModel.updateMany).toHaveBeenCalled();
    expect(f.tagModel.bulkWrite).not.toHaveBeenCalled();
  });
});
