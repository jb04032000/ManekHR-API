/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService x live pricing config.
 *
 * Proves the pricing-agility contract on the charge path: the bid stored on a
 * new campaign comes from the injected (admin-tunable) ConnectPricingConfig, and
 * the min-budget + allowed-durations rules are enforced against that live config
 * (not a hardcoded constant). All models / wallet are in-process fakes.
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
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { BoostService } from '../boost.service';
import type { ConnectPricingView } from '../../schemas/connect-pricing-config.schema';

const OWNER = '64a000000000000000000001';
const makeId = () => new Types.ObjectId().toHexString();

function fakeCampaignModel() {
  const created: any[] = [];
  return {
    _created: created,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), save: vi.fn().mockResolvedValue(undefined), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    findById: () => Promise.resolve(null),
    deleteOne: () => Promise.resolve(undefined),
    // CN-ADS-1: buildBundleAndReserve $inc's the reserve split onto the campaign.
    updateOne: () => Promise.resolve({ modifiedCount: 1 }),
  };
}
const fakeChildModel = () => ({
  create: (data: Record<string, any>) => Promise.resolve({ _id: makeId(), ...data }),
  deleteOne: () => Promise.resolve(undefined),
});
function fakeWallet() {
  // reserve must resolve truthy = "budget reserved"; the service throws
  // 'insufficient wallet balance' on a falsy result.
  return {
    reserve: vi.fn().mockResolvedValue(true),
    // CN-ADS-1: create reserves via reserveDetailed (grant/purchased split).
    reserveDetailed: vi
      .fn()
      .mockImplementation((_o: string, amount: number) =>
        Promise.resolve({ ok: true, fromGrant: 0, fromBalance: amount }),
      ),
    release: vi.fn().mockResolvedValue(undefined),
    forfeitReserve: vi.fn().mockResolvedValue(undefined),
  };
}
function fakeListingModel(listing: any) {
  return {
    findById: (id: string) => Promise.resolve(String(listing._id) === String(id) ? listing : null),
  };
}
function makeListing() {
  return {
    _id: makeId(),
    ownerUserId: new Types.ObjectId(OWNER),
    moderationStatus: 'approved',
    // CN-BOOST-2: createListingBoost also requires the listing to be live.
    status: 'active',
    boostCampaignId: null,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function pricingStub(overrides: Partial<ConnectPricingView> = {}) {
  const view: ConnectPricingView = {
    boostBidCpm: 55,
    boostBidCpc: 7,
    boostMinBudget: 149,
    boostDurations: [5, 10, 20],
    boostBudgetPresets: [149, 499],
    walletTopupMinAmount: 149,
    walletTopupPresets: [149, 499],
    ...overrides,
  };
  return { getConfig: vi.fn().mockResolvedValue(view) };
}

function build(pricing: { getConfig: any }, listing: any) {
  // pricingConfig is the LAST positional constructor arg; jobModel / rollupModel
  // / postModel (8th-10th) are passed undefined for this listing-only path.
  const svc = new BoostService(
    fakeCampaignModel() as any,
    fakeChildModel() as any,
    fakeChildModel() as any,
    fakeWallet() as any,
    { aggregateFor: vi.fn() } as any,
    undefined as any, // posthog
    fakeListingModel(listing) as any,
    undefined as any, // jobModel
    undefined as any, // rollupModel
    undefined as any, // postModel
    pricing as any, // pricingConfig (appended last)
  );
  return svc;
}

describe('BoostService uses the live pricing config', () => {
  it('charges the configured CPM bid for a reach objective', async () => {
    const listing = makeListing();
    const svc = build(pricingStub(), listing);
    const result = await svc.createListingBoost({
      ownerUserId: OWNER,
      listingId: String(listing._id),
      objective: 'reach',
      totalBudget: 500,
      days: 10,
      targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    });
    expect(result.billingEvent).toBe('cpm');
    expect(result.bid).toBe(55); // from config, NOT the old hardcoded 40
  });

  it('charges the configured CPC bid for an inquiries objective', async () => {
    const listing = makeListing();
    const svc = build(pricingStub(), listing);
    const result = await svc.createListingBoost({
      ownerUserId: OWNER,
      listingId: String(listing._id),
      objective: 'inquiries',
      totalBudget: 500,
      days: 10,
      targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    });
    expect(result.billingEvent).toBe('cpc');
    expect(result.bid).toBe(7); // from config, NOT the old hardcoded 4
  });

  it('accepts a custom duration that is not a preset (in range)', async () => {
    const listing = makeListing();
    const svc = build(pricingStub(), listing); // presets [5,10,20]
    const result = await svc.createListingBoost({
      ownerUserId: OWNER,
      listingId: String(listing._id),
      objective: 'reach',
      totalBudget: 500,
      days: 12, // not a preset, but within the 1-365 guardrail
      targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    });
    expect(result).toBeTruthy();
  });

  it('rejects a duration outside the guardrail range', async () => {
    const listing = makeListing();
    const svc = build(pricingStub(), listing);
    await expect(
      svc.createListingBoost({
        ownerUserId: OWNER,
        listingId: String(listing._id),
        objective: 'reach',
        totalBudget: 500,
        days: 400, // above BOOST_DURATION_DAY_MAX (365)
        targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a budget below the live minimum', async () => {
    const listing = makeListing();
    const svc = build(pricingStub({ boostMinBudget: 149 }), listing);
    await expect(
      svc.createListingBoost({
        ownerUserId: OWNER,
        listingId: String(listing._id),
        objective: 'reach',
        totalBudget: 100, // below 149
        days: 10,
        targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
