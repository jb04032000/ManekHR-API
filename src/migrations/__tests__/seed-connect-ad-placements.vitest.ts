/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the seed so the transitive
// decorated schema imports (AdPlacement, ConnectPricingConfig) do not trip
// vitest's reflect-metadata pipeline. Both models are positional mocks.
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

import { SeedConnectAdPlacementsService } from '../seed-connect-ad-placements';
import { CROSS_SELL_RAIL_PLACEMENTS } from '../../modules/connect/ads/services/ad-repos';

// The 9 Wave 2 cross-sell rail keys this slice adds (Step 3). Kept here so a
// regression that drops one fails loudly.
const NEW_WAVE2_KEYS = [
  'jobs_detail',
  'listing_detail',
  'post_detail',
  'profile_view',
  'activity_feed',
  'stores_hub',
  'storefront_manage',
  'pages_hub',
  'company_manage',
];

function build() {
  // Capture every $setOnInsert payload the seed upserts so we can assert the
  // shape of the new placement rows.
  const upserts: Array<{ key: string; payload: any }> = [];
  const placementModel: any = {
    updateOne: vi.fn((filter: any, update: any) => {
      upserts.push({ key: filter.key, payload: update.$setOnInsert });
      // Pretend every row is freshly inserted so placementsInserted counts up.
      return Promise.resolve({ upsertedCount: 1 });
    }),
  };
  const pricingConfigModel: any = {
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
  };
  const service = new SeedConnectAdPlacementsService(placementModel, pricingConfigModel);
  return { service, placementModel, pricingConfigModel, upserts };
}

describe('SeedConnectAdPlacementsService.runSeed (Wave 2 cross-sell rails)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeds all 9 new Wave 2 placement keys enabled, surface=rail, floorCpm=0 (mirrors company_page)', async () => {
    const f = build();
    await f.service.runSeed();

    const byKey = new Map(f.upserts.map((u) => [u.key, u.payload]));

    for (const key of NEW_WAVE2_KEYS) {
      const row = byKey.get(key);
      expect(row, `expected ${key} to be seeded`).toBeDefined();
      expect(row.enabled).toBe(true);
      expect(row.surface).toBe('rail');
      expect(row.floorCpm).toBe(0);
    }
  });

  it('the new keys match company_page defaults exactly', async () => {
    const f = build();
    await f.service.runSeed();
    const byKey = new Map(f.upserts.map((u) => [u.key, u.payload]));

    const companyPage = byKey.get('company_page');
    expect(companyPage).toBeDefined();
    for (const key of NEW_WAVE2_KEYS) {
      const row = byKey.get(key);
      expect(row.surface).toBe(companyPage.surface);
      expect(row.floorCpm).toBe(companyPage.floorCpm);
      expect(row.enabled).toBe(companyPage.enabled);
    }
  });

  it('every cross-sell rail key is seeded (seed list and CROSS_SELL_RAIL_PLACEMENTS stay in sync)', async () => {
    const f = build();
    await f.service.runSeed();
    const seededKeys = new Set(f.upserts.map((u) => u.key));

    for (const key of CROSS_SELL_RAIL_PLACEMENTS) {
      expect(seededKeys.has(key), `cross-sell key ${key} must be seeded`).toBe(true);
    }
  });
});
