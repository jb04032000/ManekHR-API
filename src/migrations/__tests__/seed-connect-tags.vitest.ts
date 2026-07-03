/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the seed so the transitive
// decorated schema import (ConnectTag) does not trip vitest's reflect-metadata
// pipeline. The model is a positional mock.
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

import { SeedConnectTagsService, buildCuratedTagSeed } from '../seed-connect-tags';

function chain(result: any) {
  const c: any = {
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

function build() {
  const tagModel: any = {
    findOne: vi.fn(() => chain(null)),
    create: vi.fn().mockResolvedValue({}),
  };
  const service = new SeedConnectTagsService(tagModel);
  return { service, tagModel };
}

describe('buildCuratedTagSeed', () => {
  it('maps the textile synonym groups into curated tags', () => {
    const seed = buildCuratedTagSeed();
    expect(seed.length).toBeGreaterThan(0);

    const zari = seed.find((tag) => tag.slug === 'zari');
    expect(zari).toBeDefined();
    expect(zari?.aliases).toEqual(expect.arrayContaining(['zardozi', 'jari']));
    expect(zari?.isCurated).toBe(true);
    expect(zari?.category).toBe('material');
    expect(zari?.labels.en).toBeTruthy();
  });

  it('produces unique, lowercase, space-free slugs', () => {
    const seed = buildCuratedTagSeed();
    const slugs = seed.map((tag) => tag.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toBe(slug.toLowerCase());
      expect(slug).not.toMatch(/\s/);
    }
  });
});

describe('SeedConnectTagsService.runSeed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts every curated tag when none exist', async () => {
    const f = build();
    const expected = buildCuratedTagSeed().length;

    const result = await f.service.runSeed();

    expect(result.inserted).toBe(expected);
    expect(result.skipped).toBe(0);
    expect(f.tagModel.create).toHaveBeenCalledTimes(expected);
  });

  it('skips existing tags on an idempotent re-run', async () => {
    const f = build();
    f.tagModel.findOne = vi.fn(() => chain({ _id: 'x' }));
    const expected = buildCuratedTagSeed().length;

    const result = await f.service.runSeed();

    expect(result.skipped).toBe(expected);
    expect(result.inserted).toBe(0);
    expect(f.tagModel.create).not.toHaveBeenCalled();
  });
});
