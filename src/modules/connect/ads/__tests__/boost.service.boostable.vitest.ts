/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing BoostService so the
// transitive schema imports do not trip vitest's reflect-metadata pipeline
// (same pattern as wallet.service.vitest.ts).
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

import { BoostService } from '../services/boost.service';

// A 24-hex owner id so `new Types.ObjectId(ownerUserId)` is valid.
const OWNER = '0123456789abcdef01234567';

/** A chainable mongoose-query stub: every builder method returns itself; the
 *  terminal `.lean()` resolves the configured result. Works for both the
 *  find().sort().limit().select().lean() chain and find(filter,proj).lean(). */
function queryModel(result: unknown) {
  const c: any = {
    find: vi.fn(() => c),
    findOne: vi.fn(() => c),
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    select: vi.fn(() => c),
    lean: vi.fn(() => Promise.resolve(result)),
  };
  return c;
}

/**
 * Construct BoostService positionally with only the models boostable() needs:
 *   campaignModel, listingModel, jobModel, profileModel. Everything else is
 *   undefined (boostable touches none of it).
 */
function makeSvc(opts: {
  listings?: unknown[];
  jobs?: unknown[];
  rfqs?: unknown[];
  inFlightCampaigns?: Array<{ _id: string }>;
  profile?: unknown;
}) {
  const campaignModel = queryModel(opts.inFlightCampaigns ?? []);
  const listingModel = queryModel(opts.listings ?? []);
  const jobModel = queryModel(opts.jobs ?? []);
  const rfqModel = queryModel(opts.rfqs ?? []);
  const profileModel = queryModel(opts.profile ?? null);
  const svc = new BoostService(
    campaignModel, // campaignModel
    undefined as any, // adSetModel
    undefined as any, // creativeModel
    undefined as any, // wallet
    undefined as any, // rollups
    undefined, // posthog
    listingModel, // listingModel
    jobModel, // jobModel
    undefined, // rollupModel
    undefined, // postModel
    undefined, // pricingConfig
    profileModel, // profileModel
    rfqModel, // rfqModel
  );
  return { svc, campaignModel };
}

describe('BoostService.boostable', () => {
  it('groups eligible listings + jobs, maps fields, and reads intents', async () => {
    const { svc } = makeSvc({
      listings: [
        { _id: 'L1', title: 'Zari saree', category: 'weaving', images: ['img1.jpg'] },
        { _id: 'L2', title: 'Thread cones', category: 'raw-material', images: [] },
      ],
      jobs: [
        { _id: 'J1', title: 'Karigar needed', role: 'karigar', category: 'job-work', views: 42 },
      ],
      rfqs: [{ _id: 'R1', title: 'Need 5000m cotton', category: 'weaving' }],
      profile: { openTo: { work: true, hiring: true, deals: false, customOrders: false } },
    });

    const out = await svc.boostable(OWNER);

    expect(out.listings).toEqual([
      {
        id: 'L1',
        kind: 'boost_listing',
        title: 'Zari saree',
        image: 'img1.jpg',
        subtitle: 'weaving',
        views: null,
      },
      {
        id: 'L2',
        kind: 'boost_listing',
        title: 'Thread cones',
        image: null,
        subtitle: 'raw-material',
        views: null,
      },
    ]);
    expect(out.jobs).toEqual([
      {
        id: 'J1',
        kind: 'boost_job',
        title: 'Karigar needed',
        image: null,
        subtitle: 'karigar',
        views: 42,
      },
    ]);
    expect(out.rfqs).toEqual([
      {
        id: 'R1',
        kind: 'boost_rfq',
        title: 'Need 5000m cotton',
        image: null,
        subtitle: 'weaving',
        views: null,
      },
    ]);
    expect(out.counts).toEqual({ listings: 2, jobs: 1, rfqs: 1 });
    expect(out.intents).toEqual({ work: true, hiring: true, deals: false, customOrders: false });
  });

  it('excludes items whose linked campaign is still in-flight', async () => {
    const { svc } = makeSvc({
      listings: [
        {
          _id: 'L1',
          title: 'Live boost',
          category: 'weaving',
          images: [],
          boostCampaignId: 'C_LIVE',
        },
        {
          _id: 'L2',
          title: 'Done boost',
          category: 'weaving',
          images: [],
          boostCampaignId: 'C_DONE',
        },
        { _id: 'L3', title: 'Never boosted', category: 'weaving', images: [] },
      ],
      // Only C_LIVE is returned by the in-flight query (pending/active/paused).
      inFlightCampaigns: [{ _id: 'C_LIVE' }],
      profile: null,
    });

    const out = await svc.boostable(OWNER);

    // L1 (in-flight) is filtered out; L2 (completed prior boost) + L3 stay.
    expect(out.listings.map((l) => l.id)).toEqual(['L2', 'L3']);
    expect(out.counts.listings).toBe(2);
  });

  it('caps the displayed list at 3 while counts reflect the full eligible set', async () => {
    const listings = Array.from({ length: 5 }, (_, i) => ({
      _id: `L${i}`,
      title: `Listing ${i}`,
      category: 'weaving',
      images: [],
    }));
    const { svc } = makeSvc({ listings, profile: null });

    const out = await svc.boostable(OWNER);

    expect(out.listings).toHaveLength(3);
    expect(out.counts.listings).toBe(5);
  });

  it('falls back to all-false intents when the caller has no profile', async () => {
    const { svc } = makeSvc({ profile: null });
    const out = await svc.boostable(OWNER);
    expect(out.intents).toEqual({ work: false, hiring: false, deals: false, customOrders: false });
    expect(out.listings).toEqual([]);
    expect(out.jobs).toEqual([]);
  });
});
