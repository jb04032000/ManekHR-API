/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema import (ConnectTag) does not trip vitest's
// reflect-metadata pipeline. The model + PostHog are positional mocks.
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

import { TagService } from '../tag.service';

/** Chainable query stand-in: select/sort/limit/lean/exec in any order. */
function chain(result: any) {
  const c: any = {
    select: vi.fn(() => c),
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

function build() {
  const tagModel: any = {
    find: vi.fn(() => chain([])),
    updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ upsertedCount: 0 }) })),
  };
  const posthog = { capture: vi.fn() };
  const service = new TagService(tagModel, posthog as any);
  return { service, tagModel, posthog };
}

describe('TagService.normalizeHashtags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves aliases to the canonical slug, lowercases, and de-dupes', async () => {
    const f = build();
    f.tagModel.find = vi.fn(() => chain([{ slug: 'zari', aliases: ['zardozi', 'jari'] }]));

    const result = await f.service.normalizeHashtags(['Zardozi', 'zari', 'randomword']);

    expect(result).toEqual(['zari', 'randomword']);
  });

  it('returns [] without a query for empty input', async () => {
    const f = build();
    const result = await f.service.normalizeHashtags([]);
    expect(result).toEqual([]);
    expect(f.tagModel.find).not.toHaveBeenCalled();
  });
});

describe('TagService.recordUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts each slug, incrementing usageCount and seeding open-tag defaults', async () => {
    const f = build();
    await f.service.recordUsage(['zari', 'newtag'], 'user1');

    expect(f.tagModel.updateOne).toHaveBeenCalledTimes(2);
    const [filter, update, options] = f.tagModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ slug: 'zari' });
    expect(update.$inc).toEqual({ usageCount: 1 });
    expect(update.$setOnInsert).toMatchObject({ isCurated: false });
    expect(options).toEqual({ upsert: true });
  });

  it('never throws when the upsert fails (post create must not break)', async () => {
    const f = build();
    f.tagModel.updateOne = vi.fn(() => ({ exec: vi.fn().mockRejectedValue(new Error('db down')) }));
    await expect(f.service.recordUsage(['zari'], 'user1')).resolves.toBeUndefined();
  });

  it('does nothing for an empty slug list', async () => {
    const f = build();
    await f.service.recordUsage([], 'user1');
    expect(f.tagModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('TagService.autocomplete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefix-matches slug or alias and returns the tag views', async () => {
    const f = build();
    f.tagModel.find = vi.fn(() =>
      chain([{ slug: 'zari', labels: { en: 'Zari' }, category: 'material', usageCount: 12 }]),
    );

    const result = await f.service.autocomplete('za', 10);

    const findArg = f.tagModel.find.mock.calls[0][0];
    expect(findArg.$or).toBeDefined();
    expect(result[0]).toMatchObject({ slug: 'zari', category: 'material' });
  });

  it('returns [] for a blank query without a DB call', async () => {
    const f = build();
    const result = await f.service.autocomplete('  ', 10);
    expect(result).toEqual([]);
    expect(f.tagModel.find).not.toHaveBeenCalled();
  });
});

describe('TagService.getTrending', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns tags with a positive trending score, highest first', async () => {
    const f = build();
    f.tagModel.find = vi.fn(() =>
      chain([
        {
          slug: 'zari',
          labels: { en: 'Zari' },
          category: 'material',
          usageCount: 5,
          trendingScore: 9,
        },
      ]),
    );

    const result = await f.service.getTrending(20);

    expect(f.tagModel.find.mock.calls[0][0]).toEqual({ trendingScore: { $gt: 0 } });
    expect(result[0]).toMatchObject({ slug: 'zari', trendingScore: 9 });
  });
});
