/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService.createListingBoost unit tests (M2.1) -- strict TDD.
 *
 * The shipped post-boost pipeline (create / pause / resume / status) is covered
 * by boost.service.vitest.ts; this file covers ONLY the listing-boost path so
 * the post tests stay byte-identical proof that the bundle refactor is inert.
 *
 * All Mongo models, WalletService, RollupReader, PostHog, and the Listing model
 * are in-process fakes. No real DB or network.
 */

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

import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { BoostService } from '../boost.service';
import type { CreateListingBoostInput, RollupReader } from '../boost.service';

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

// Owner ids are real ObjectId hex strings: the listing schema stores
// `ownerUserId` as an ObjectId and BoostService now compares with `.equals()`.
const OWNER = '64a000000000000000000001';
const OTHER = '64a000000000000000000002';

function createFakeCampaignModel(existingBoost?: { _id: string; status: string }) {
  const created: any[] = [];
  const deletedIds: string[] = [];
  return {
    _created: created,
    _deletedIds: deletedIds,
    create(data: Record<string, any>) {
      const save = vi.fn().mockResolvedValue(undefined);
      const doc = { _id: makeId(), save, ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    findById(id: string) {
      if (existingBoost && String(existingBoost._id) === String(id)) {
        return Promise.resolve(existingBoost);
      }
      return Promise.resolve(null);
    },
    updateOne(_filter: Record<string, any>, _update: Record<string, any>) {
      return Promise.resolve({ modifiedCount: 1 });
    },
    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeAdSetModel() {
  const created: any[] = [];
  const deletedIds: string[] = [];
  return {
    _created: created,
    _deletedIds: deletedIds,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeCreativeModel() {
  const created: any[] = [];
  const deletedIds: string[] = [];
  return {
    _created: created,
    _deletedIds: deletedIds,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

function createFakeWallet(reserveResult = true) {
  return {
    reserve: vi.fn().mockResolvedValue(reserveResult),
    // CN-ADS-1 (feed harden): create now reserves via reserveDetailed (returns
    // the grant/purchased split). No tracked split -> all from purchased balance.
    reserveDetailed: vi.fn().mockImplementation((_o: string, amount: number) =>
      Promise.resolve({
        ok: reserveResult,
        fromGrant: 0,
        fromBalance: reserveResult ? amount : 0,
      }),
    ),
    release: vi.fn().mockResolvedValue(undefined),
    forfeitReserve: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeRollups(): RollupReader {
  return {
    aggregateFor: vi.fn().mockResolvedValue({
      impressions: 0,
      viewableImpressions: 0,
      clicks: 0,
      validClicks: 0,
      spend: 0,
    }),
  };
}

function makeListingDoc(overrides: Record<string, any> = {}) {
  return {
    _id: makeId(),
    ownerUserId: new Types.ObjectId(OWNER),
    moderationStatus: 'approved',
    // CN-BOOST-2 (feed harden): createListingBoost now also requires the listing
    // to be live (status:'active'), so the default fixture is active.
    status: 'active',
    boostCampaignId: null as string | null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createFakeListingModel(seed: ReturnType<typeof makeListingDoc> | null) {
  return {
    findById(id: string) {
      if (seed && String(seed._id) === String(id)) return Promise.resolve(seed);
      return Promise.resolve(null);
    },
  };
}

const BASE: Omit<CreateListingBoostInput, 'listingId'> = {
  ownerUserId: OWNER,
  objective: 'reach',
  totalBudget: 500,
  days: 7,
  targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
};

function buildService(opts: {
  listing: ReturnType<typeof makeListingDoc> | null;
  reserve?: boolean;
  existingBoost?: { _id: string; status: string };
  posthog?: { capture: ReturnType<typeof vi.fn> };
  noListingModel?: boolean;
}) {
  const campaignModel = createFakeCampaignModel(opts.existingBoost);
  const adSetModel = createFakeAdSetModel();
  const creativeModel = createFakeCreativeModel();
  const wallet = createFakeWallet(opts.reserve ?? true);
  const listingModel = opts.noListingModel ? undefined : createFakeListingModel(opts.listing);

  const svc = new BoostService(
    campaignModel as any,
    adSetModel as any,
    creativeModel as any,
    wallet as any,
    createFakeRollups(),
    opts.posthog as any,
    listingModel as any,
  );

  return { svc, campaignModel, adSetModel, creativeModel, wallet };
}

describe('BoostService.createListingBoost (M2.1)', () => {
  it('approved + owned listing: creates boost_listing campaign + promoted_listing creative on marketplace_grid + marketplace_rail + feed_sponsored, reserves, links boostCampaignId', async () => {
    const listing = makeListingDoc({ moderationStatus: 'approved', boostCampaignId: null });
    const { svc, adSetModel, creativeModel, wallet } = buildService({ listing });

    const result = await svc.createListingBoost({ ...BASE, listingId: String(listing._id) });

    expect(result.kind).toBe('boost_listing');
    expect(result.billingEvent).toBe('cpm');
    expect(result.bid).toBe(40);
    // Publish-then-moderate: a launched boost serves immediately (active).
    expect(result.status).toBe('active');
    expect(result.sourceListingId).toBe(String(listing._id));

    // A listing boost binds the in-grid promoted cell (marketplace_grid) so the
    // grid slot actually gets a campaign to pin at the top, ALONGSIDE the existing
    // desktop rail (marketplace_rail) + the unified in-feed slot (feed_sponsored).
    expect(adSetModel._created[0].placements).toEqual([
      'marketplace_grid',
      'marketplace_rail',
      'feed_sponsored',
    ]);
    // Guard the specific fix: the grid placement is present.
    expect(adSetModel._created[0].placements).toContain('marketplace_grid');

    const creative = creativeModel._created[0];
    expect(creative.kind).toBe('promoted_listing');
    expect(creative.listingRef).toBe(String(listing._id));
    // Publish-then-moderate: the creative is approved on create so it serves.
    expect(creative.reviewStatus).toBe('approved');
    expect(creative.postRef).toBeUndefined();

    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 500, String(result._id));

    expect(String(listing.boostCampaignId)).toBe(String(result._id));
    expect(listing.save).toHaveBeenCalled();
  });

  it('spotlight upgrade: bills at the premium bid (base x multiplier) + adds the spotlight_rail placement', async () => {
    const listing = makeListingDoc();
    const { svc, adSetModel } = buildService({ listing });

    const result = await svc.createListingBoost({
      ...BASE,
      listingId: String(listing._id),
      spotlight: true,
    });

    // Default multiplier is 2 (positional construction uses CONNECT_PRICING_DEFAULTS),
    // so a reach (cpm) boost bids 40 x 2 = 80.
    expect(result.bid).toBe(80);
    // Spotlight appends spotlight_rail AFTER the base placements (grid + rail + feed).
    expect(adSetModel._created[0].placements).toEqual([
      'marketplace_grid',
      'marketplace_rail',
      'feed_sponsored',
      'spotlight_rail',
    ]);
  });

  it('no spotlight: base bid + no spotlight_rail placement', async () => {
    const listing = makeListingDoc();
    const { svc, adSetModel } = buildService({ listing });
    const result = await svc.createListingBoost({ ...BASE, listingId: String(listing._id) });
    expect(result.bid).toBe(40);
    expect(adSetModel._created[0].placements).not.toContain('spotlight_rail');
  });

  it('inquiries objective: billingEvent cpc, bid 4', async () => {
    const listing = makeListingDoc();
    const { svc } = buildService({ listing });

    const result = await svc.createListingBoost({
      ...BASE,
      listingId: String(listing._id),
      objective: 'inquiries',
    });

    expect(result.billingEvent).toBe('cpc');
    expect(result.bid).toBe(4);
  });

  it('missing listing: throws NotFoundException', async () => {
    const { svc } = buildService({ listing: null });
    await expect(
      svc.createListingBoost({ ...BASE, listingId: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listing owned by another user: throws NotFoundException (no ownership leak)', async () => {
    const listing = makeListingDoc({ ownerUserId: new Types.ObjectId(OTHER) });
    const { svc, adSetModel } = buildService({ listing });

    await expect(
      svc.createListingBoost({ ...BASE, listingId: String(listing._id) }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adSetModel._created).toHaveLength(0);
  });

  it('listing not yet approved (moderationStatus pending): throws BadRequestException', async () => {
    const listing = makeListingDoc({ moderationStatus: 'pending' });
    const { svc, adSetModel } = buildService({ listing });

    await expect(
      svc.createListingBoost({ ...BASE, listingId: String(listing._id) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(adSetModel._created).toHaveLength(0);
  });

  it('listing with an in-flight (active) boost: throws BadRequestException', async () => {
    const existingBoost = { _id: makeId(), status: 'active' };
    const listing = makeListingDoc({ boostCampaignId: existingBoost._id });
    const { svc } = buildService({ listing, existingBoost });

    await expect(
      svc.createListingBoost({ ...BASE, listingId: String(listing._id) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listing whose prior boost is completed: allowed, relinks to the new campaign', async () => {
    const priorBoost = { _id: makeId(), status: 'completed' };
    const listing = makeListingDoc({ boostCampaignId: priorBoost._id });
    const { svc } = buildService({ listing, existingBoost: priorBoost });

    const result = await svc.createListingBoost({ ...BASE, listingId: String(listing._id) });

    expect(result.kind).toBe('boost_listing');
    expect(String(listing.boostCampaignId)).toBe(String(result._id));
    expect(listing.save).toHaveBeenCalled();
  });

  it('wallet reserve fails: BadRequestException, all 3 docs cleaned up, listing NOT linked', async () => {
    const listing = makeListingDoc({ boostCampaignId: null });
    const { svc, campaignModel, adSetModel, creativeModel } = buildService({
      listing,
      reserve: false,
    });

    await expect(
      svc.createListingBoost({ ...BASE, listingId: String(listing._id) }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(campaignModel._deletedIds).toHaveLength(1);
    expect(adSetModel._deletedIds).toHaveLength(1);
    expect(creativeModel._deletedIds).toHaveLength(1);
    expect(listing.save).not.toHaveBeenCalled();
    expect(listing.boostCampaignId).toBeNull();
  });

  it('emits ads.boost_created with target=listing when posthog is provided', async () => {
    const listing = makeListingDoc();
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ listing, posthog });

    const result = await svc.createListingBoost({
      ...BASE,
      listingId: String(listing._id),
      objective: 'inquiries',
    });

    expect(posthog.capture).toHaveBeenCalledOnce();
    const call = posthog.capture.mock.calls[0][0];
    expect(call.event).toBe('ads.boost_created');
    expect(call.properties.target).toBe('listing');
    expect(call.properties.listingId).toBe(String(listing._id));
    expect(call.properties.campaignId).toBe(String(result._id));
    expect(call.properties.billingEvent).toBe('cpc');
    expect(call.properties.totalBudget).toBe(500);
    expect(call.properties.days).toBe(7);
  });

  it('does NOT emit posthog when the wallet reserve fails', async () => {
    const listing = makeListingDoc();
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ listing, reserve: false, posthog });

    await expect(
      svc.createListingBoost({ ...BASE, listingId: String(listing._id) }),
    ).rejects.toBeDefined();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('throws a clear error when the Listing model is not injected (positional post-only construction)', async () => {
    const { svc } = buildService({ listing: null, noListingModel: true });
    await expect(svc.createListingBoost({ ...BASE, listingId: 'x' })).rejects.toThrow(
      /listingModel/,
    );
  });
});
