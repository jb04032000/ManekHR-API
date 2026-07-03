/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService unit tests -- strict TDD.
 *
 * All Mongo models, WalletService, and RollupReader are replaced with
 * in-process fakes. No real DB or network calls.
 *
 * Test order:
 *   T21 - create()
 *   T22 - pause() / resume()
 *   T23 - status()
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
import { BoostService, ROLLUP_READER } from '../boost.service';
import type { RollupReader } from '../boost.service';

// ---------------------------------------------------------------------------
// Fake model builders
// ---------------------------------------------------------------------------

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

// Owner ids are real ObjectId hex strings: the campaign schema stores
// `ownerUserId` as an ObjectId and loadAndVerify now compares with `.equals()`.
const OWNER = '64a000000000000000000001';
const OTHER = '64a000000000000000000002';

/** Minimal fake campaign document returned by findById. */
function makeCampaignDoc(overrides: Record<string, any> = {}) {
  const saveSpy = vi.fn().mockResolvedValue(undefined);
  return {
    _id: makeId(),
    ownerUserId: new Types.ObjectId(OWNER),
    kind: 'boost_post',
    sourcePostId: 'post-001',
    objective: 'reach',
    status: 'pending_review',
    totalBudget: 500,
    budgetSpent: 0,
    pacing: 'even',
    billingEvent: 'cpm',
    bid: 40,
    save: saveSpy,
    ...overrides,
  };
}

/**
 * Fake campaign model.
 *
 * - create(data): stores the doc and returns it with a generated _id + save spy.
 * - findById(id): returns the pre-seeded doc or null.
 * - deleteOne({ _id }): tracks calls.
 */
function createFakeCampaignModel(seedDoc?: ReturnType<typeof makeCampaignDoc>) {
  const created: any[] = [];
  const deletedIds: string[] = [];

  return {
    _created: created,
    _deletedIds: deletedIds,
    _seed: seedDoc ?? null,

    create(data: Record<string, any>) {
      const save = vi.fn().mockResolvedValue(undefined);
      const doc = { _id: makeId(), save, ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },

    findById(id: string) {
      if (this._seed && String(this._seed._id) === String(id)) {
        return Promise.resolve(this._seed);
      }
      return Promise.resolve(null);
    },

    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
  };
}

/** Fake AdSet model -- create + deleteOne. */
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

/** Fake AdCreative model -- create + deleteOne. */
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

/** Fake WalletService with configurable reserve result. */
function createFakeWallet(reserveResult = true) {
  return {
    reserve: vi.fn().mockResolvedValue(reserveResult),
    // CN-ADS-1 (feed harden): resume()/create now use reserveDetailed (returns the
    // grant/purchased split). A campaign with no tracked split reserves entirely
    // from purchased balance, so the fake reports fromBalance = the amount.
    reserveDetailed: vi.fn().mockImplementation((_o: string, amount: number) =>
      Promise.resolve({
        ok: reserveResult,
        fromGrant: 0,
        fromBalance: reserveResult ? amount : 0,
      }),
    ),
    release: vi.fn().mockResolvedValue(undefined),
    // CN-PURGE-1 forfeit path (used by the account-purge stopForPost branch).
    forfeitReserve: vi.fn().mockResolvedValue(undefined),
  };
}

/** Fixed rollup metrics returned by the fake RollupReader. */
const FIXED_ROLLUP = {
  impressions: 1200,
  viewableImpressions: 900,
  clicks: 45,
  validClicks: 40,
  spend: 120,
};

function createFakeRollups(): RollupReader {
  return {
    aggregateFor: vi.fn().mockResolvedValue(FIXED_ROLLUP),
  };
}

// ---------------------------------------------------------------------------
// T22 -- pause() / resume()
//
// NOTE: post-boost create() was retired in M2.6 (boost is listing-only). The
// shared buildBundleAndReserve pipeline (billing event / bid / reserve-fail
// cleanup) is now covered via createListingBoost in boost.service.listing.vitest.ts.
// pause / resume / status below are kind-agnostic and stay here.
// ---------------------------------------------------------------------------

describe('BoostService.pause (T22)', () => {
  it('active campaign: releases unspent amount, sets status to paused, calls save', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-001',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      totalBudget: 500,
      budgetSpent: 120,
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    const result = await svc.pause('camp-001', OWNER);

    expect(wallet.release).toHaveBeenCalledWith(OWNER, 380, 'camp-001', {
      fromGrant: 0,
      fromBalance: 380,
    });
    expect(result.status).toBe('paused');
    expect(doc.save).toHaveBeenCalled();
  });

  it('non-active campaign: returns as-is, no release called', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-002',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'paused',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    const result = await svc.pause('camp-002', OWNER);

    expect(wallet.release).not.toHaveBeenCalled();
    expect(result.status).toBe('paused');
  });

  it('cross-workspace: throws NotFoundException, no release', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-003',
      ownerUserId: new Types.ObjectId(OTHER),
      status: 'active',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    await expect(svc.pause('camp-003', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('missing campaign id: throws NotFoundException', async () => {
    const campaignModel = createFakeCampaignModel(); // no seed

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    await expect(svc.pause('nonexistent-id', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BoostService.resume (T22)', () => {
  it('paused campaign with need > 0 and reserve true -> status active, reserve called with need', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-010',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'paused',
      totalBudget: 500,
      budgetSpent: 120,
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet(true);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    const result = await svc.resume('camp-010', OWNER);

    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 380, 'camp-010');
    expect(result.status).toBe('active');
    expect(doc.save).toHaveBeenCalled();
  });

  it('paused campaign with need > 0 and reserve false -> throws BadRequestException', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-011',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'paused',
      totalBudget: 500,
      budgetSpent: 120,
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet(false);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    await expect(svc.resume('camp-011', OWNER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('paused campaign with need === 0 (fully spent) -> reserve NOT called, status active', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-012',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'paused',
      totalBudget: 500,
      budgetSpent: 500, // fully spent
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet(true);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    const result = await svc.resume('camp-012', OWNER);

    expect(wallet.reserveDetailed).not.toHaveBeenCalled();
    expect(result.status).toBe('active');
    expect(doc.save).toHaveBeenCalled();
  });

  it('cross-workspace: throws NotFoundException', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-013',
      ownerUserId: new Types.ObjectId(OTHER),
      status: 'paused',
    });
    const campaignModel = createFakeCampaignModel(doc);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    await expect(svc.resume('camp-013', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('missing campaign id: throws NotFoundException', async () => {
    const svc = new BoostService(
      createFakeCampaignModel() as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    await expect(svc.resume('nonexistent-id', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// cancel() -- advertiser cancels their OWN boost (full refund, no fee, unlink)
// ---------------------------------------------------------------------------

/** Fake source doc (listing / job / rfq) with a saveable boostCampaignId. */
function makeSourceDoc(id: string, boostCampaignId: string) {
  return {
    _id: id,
    boostCampaignId: boostCampaignId,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/** Fake source model whose findById returns the seeded doc (or null). */
function createFakeSourceModel(seed: ReturnType<typeof makeSourceDoc> | null) {
  return {
    findById(id: string) {
      if (seed && String(seed._id) === String(id)) return Promise.resolve(seed);
      return Promise.resolve(null);
    },
  };
}

describe('BoostService.cancel', () => {
  it('active boost: releases the FULL unspent, unlinks the source, sets status completed', async () => {
    const listing = makeSourceDoc('listing-1', 'camp-c01');
    const doc = makeCampaignDoc({
      _id: 'camp-c01',
      ownerUserId: new Types.ObjectId(OWNER),
      kind: 'boost_listing',
      status: 'active',
      totalBudget: 500,
      budgetSpent: 120,
      sourceListingId: 'listing-1',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
      undefined, // posthog
      createFakeSourceModel(listing) as any, // listingModel
    );

    const result = await svc.cancel('camp-c01', OWNER);

    // FULL unspent (500 - 120 = 380), no fee withheld.
    expect(wallet.release).toHaveBeenCalledWith(OWNER, 380, 'camp-c01', {
      fromGrant: 0,
      fromBalance: 380,
    });
    expect(listing.boostCampaignId).toBeNull();
    expect(listing.save).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(doc.save).toHaveBeenCalled();
  });

  it('paused boost: does NOT call wallet.release (no throw), unlinks, sets completed', async () => {
    const listing = makeSourceDoc('listing-2', 'camp-c02');
    const doc = makeCampaignDoc({
      _id: 'camp-c02',
      ownerUserId: new Types.ObjectId(OWNER),
      kind: 'boost_listing',
      status: 'paused',
      totalBudget: 500,
      budgetSpent: 120,
      sourceListingId: 'listing-2',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
      undefined,
      createFakeSourceModel(listing) as any,
    );

    const result = await svc.cancel('camp-c02', OWNER);

    // pause() already released the budget -- releasing again would over-release.
    expect(wallet.release).not.toHaveBeenCalled();
    expect(listing.boostCampaignId).toBeNull();
    expect(listing.save).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('pending_review boost: releases the full unspent, unlinks, completed', async () => {
    const job = makeSourceDoc('job-1', 'camp-c03');
    const doc = makeCampaignDoc({
      _id: 'camp-c03',
      ownerUserId: new Types.ObjectId(OWNER),
      kind: 'boost_job',
      status: 'pending_review',
      totalBudget: 300,
      budgetSpent: 0,
      sourceJobId: 'job-1',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
      undefined,
      undefined, // listingModel
      createFakeSourceModel(job) as any, // jobModel
    );

    const result = await svc.cancel('camp-c03', OWNER);

    expect(wallet.release).toHaveBeenCalledWith(OWNER, 300, 'camp-c03', {
      fromGrant: 0,
      fromBalance: 300,
    });
    expect(job.boostCampaignId).toBeNull();
    expect(job.save).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('already completed boost: no-op (no release, no unlink, status unchanged)', async () => {
    const listing = makeSourceDoc('listing-3', 'camp-c04');
    const doc = makeCampaignDoc({
      _id: 'camp-c04',
      ownerUserId: new Types.ObjectId(OWNER),
      kind: 'boost_listing',
      status: 'completed',
      totalBudget: 500,
      budgetSpent: 200,
      sourceListingId: 'listing-3',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
      undefined,
      createFakeSourceModel(listing) as any,
    );

    const result = await svc.cancel('camp-c04', OWNER);

    expect(wallet.release).not.toHaveBeenCalled();
    expect(listing.boostCampaignId).toBe('camp-c04'); // untouched
    expect(listing.save).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('already rejected boost: no-op (no release, no unlink, status unchanged)', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-c05',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'rejected',
      totalBudget: 500,
      budgetSpent: 0,
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    const result = await svc.cancel('camp-c05', OWNER);

    expect(wallet.release).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('non-owner caller: throws NotFoundException, no release (via loadAndVerify)', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-c06',
      ownerUserId: new Types.ObjectId(OTHER),
      status: 'active',
      totalBudget: 500,
      budgetSpent: 0,
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
    );

    await expect(svc.cancel('camp-c06', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('unlink failure is best-effort: cancel still completes (refund + status applied)', async () => {
    const listing = makeSourceDoc('listing-4', 'camp-c07');
    // Force the unlink to blow up; cancel must swallow it and still complete.
    listing.save = vi.fn().mockRejectedValue(new Error('db down'));
    const doc = makeCampaignDoc({
      _id: 'camp-c07',
      ownerUserId: new Types.ObjectId(OWNER),
      kind: 'boost_listing',
      status: 'active',
      totalBudget: 500,
      budgetSpent: 0,
      sourceListingId: 'listing-4',
    });
    const campaignModel = createFakeCampaignModel(doc);
    const wallet = createFakeWallet();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      wallet as any,
      createFakeRollups(),
      undefined,
      createFakeSourceModel(listing) as any,
    );

    const result = await svc.cancel('camp-c07', OWNER);

    expect(wallet.release).toHaveBeenCalledWith(OWNER, 500, 'camp-c07', {
      fromGrant: 0,
      fromBalance: 500,
    });
    expect(result.status).toBe('completed');
    expect(doc.save).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T23 -- status()
// ---------------------------------------------------------------------------

describe('BoostService.status (T23)', () => {
  it('returns BoostStatusView from campaign + rollup aggregation', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-100',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      objective: 'reach',
      totalBudget: 500,
      budgetSpent: 120,
    });
    const campaignModel = createFakeCampaignModel(doc);
    const rollups = createFakeRollups();

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      rollups,
    );

    const view = await svc.status('camp-100', OWNER);

    expect(view.status).toBe('active');
    expect(view.objective).toBe('reach');
    expect(view.spend).toBe(120);
    expect(view.budgetRemaining).toBe(380); // 500 - 120
    expect(view.reach).toBe(FIXED_ROLLUP.viewableImpressions); // 900
    expect(view.views).toBe(FIXED_ROLLUP.impressions); // 1200
    expect(view.clicks).toBe(FIXED_ROLLUP.clicks); // 45

    expect(rollups.aggregateFor).toHaveBeenCalledWith('camp-100');
  });

  it('budgetRemaining is clamped to 0 when budgetSpent > totalBudget', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-101',
      ownerUserId: new Types.ObjectId(OWNER),
      status: 'active',
      totalBudget: 100,
      budgetSpent: 120, // over-spent (edge case)
    });
    const campaignModel = createFakeCampaignModel(doc);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    const view = await svc.status('camp-101', OWNER);

    expect(view.budgetRemaining).toBe(0);
  });

  it('cross-workspace: throws NotFoundException', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-102',
      ownerUserId: new Types.ObjectId(OTHER),
      status: 'active',
    });
    const campaignModel = createFakeCampaignModel(doc);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    await expect(svc.status('camp-102', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('missing campaign id: throws NotFoundException', async () => {
    const svc = new BoostService(
      createFakeCampaignModel() as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    await expect(svc.status('nonexistent-id', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  // Regression: the campaign schema declares `ownerUserId` with
  // `@Prop({ type: Types.ObjectId })`, but `Types.ObjectId` (the value class) is
  // NOT a recognised SchemaType, so @nestjs/mongoose resolves the path to
  // `Mixed` -- no casting. A campaign created from the JWT (`req.user.sub`, a
  // plain hex STRING) therefore stores + hydrates `ownerUserId` as a raw string,
  // which has no `.equals()` method. loadAndVerify must compare by value, not by
  // calling `.equals()` on it, or every freshly-launched boost 500s on its
  // results page. See live stack: "campaign.ownerUserId.equals is not a function".
  it('owner stored as a plain STRING (Mixed path): returns the view, does NOT throw', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-200',
      ownerUserId: OWNER, // raw hex string, exactly as the create path writes it
      status: 'active',
      objective: 'reach',
      totalBudget: 500,
      budgetSpent: 120,
    });
    const campaignModel = createFakeCampaignModel(doc);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    const view = await svc.status('camp-200', OWNER);
    expect(view.status).toBe('active');
    expect(view.budgetRemaining).toBe(380);
  });

  it('owner stored as a plain STRING but mismatched: throws NotFoundException (no leak)', async () => {
    const doc = makeCampaignDoc({
      _id: 'camp-201',
      ownerUserId: OTHER, // raw hex string for a DIFFERENT owner
      status: 'active',
    });
    const campaignModel = createFakeCampaignModel(doc);

    const svc = new BoostService(
      campaignModel as any,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
    );

    await expect(svc.status('camp-201', OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// list() -- caller's campaigns enriched with REAL metrics + resolved source
// titles / thumbnails (batched, no N+1)
// ---------------------------------------------------------------------------

/**
 * A chainable mongoose-query stub for the campaign find().sort().lean() chain
 * in list(): every builder returns itself; the terminal .lean() resolves the
 * seeded campaigns array. Spies on .find so we can assert the owner filter.
 */
function createFakeListCampaignModel(campaigns: any[]) {
  const c: any = {
    find: vi.fn(() => c),
    sort: vi.fn(() => c),
    lean: vi.fn(() => Promise.resolve(campaigns)),
  };
  return c;
}

/** Fake rollup model: aggregate() resolves the seeded per-campaign buckets. */
function createFakeRollupModel(buckets: any[] = []) {
  return {
    aggregate: vi.fn().mockResolvedValue(buckets),
  };
}

/**
 * A chainable source-model stub for the batch title lookup
 * (find({ _id: { $in } }).select().lean()). Captures the filter passed to find
 * so a test can assert ONE $in query (not one findById per row).
 */
function createFakeSourceTitleModel(docs: any[]) {
  const calls: any[] = [];
  const c: any = {
    _findCalls: calls,
    find: vi.fn((filter: any) => {
      calls.push(filter);
      return c;
    }),
    select: vi.fn(() => c),
    lean: vi.fn(() => Promise.resolve(docs)),
  };
  return c;
}

describe('BoostService.list (source title + image enrichment)', () => {
  it('resolves listing title + first image, job title, rfq title, and post body snippet; batched via $in', async () => {
    const campaigns = [
      {
        _id: 'camp-L',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_listing',
        objective: 'reach',
        status: 'active',
        totalBudget: 500,
        budgetSpent: 100,
        startAt: new Date(),
        endAt: new Date(),
        sourceListingId: 'listing-1',
      },
      {
        _id: 'camp-L2',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_listing',
        objective: 'reach',
        status: 'active',
        totalBudget: 500,
        budgetSpent: 0,
        startAt: new Date(),
        endAt: new Date(),
        sourceListingId: 'listing-2',
      },
      {
        _id: 'camp-J',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_job',
        objective: 'applications',
        status: 'active',
        totalBudget: 300,
        budgetSpent: 0,
        startAt: new Date(),
        endAt: new Date(),
        sourceJobId: 'job-1',
      },
      {
        _id: 'camp-R',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_rfq',
        objective: 'quotes',
        status: 'active',
        totalBudget: 300,
        budgetSpent: 0,
        startAt: new Date(),
        endAt: new Date(),
        sourceRfqId: 'rfq-1',
      },
      {
        _id: 'camp-P',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_post',
        objective: 'reach',
        status: 'active',
        totalBudget: 200,
        budgetSpent: 0,
        startAt: new Date(),
        endAt: new Date(),
        sourcePostId: 'post-1',
      },
    ];

    const campaignModel = createFakeListCampaignModel(campaigns);
    const rollupModel = createFakeRollupModel([]);
    const longBody = 'x'.repeat(120);
    const listingModel = createFakeSourceTitleModel([
      { _id: 'listing-1', title: 'Zari saree', images: ['cover-1.jpg', 'extra.jpg'] },
      { _id: 'listing-2', title: 'Thread cones', images: [] },
    ]);
    const jobModel = createFakeSourceTitleModel([{ _id: 'job-1', title: 'Karigar needed' }]);
    const rfqModel = createFakeSourceTitleModel([{ _id: 'rfq-1', title: 'Need 5000m cotton' }]);
    const postModel = createFakeSourceTitleModel([{ _id: 'post-1', body: longBody }]);

    const svc = new BoostService(
      campaignModel, // campaignModel
      createFakeAdSetModel() as any, // adSetModel
      createFakeCreativeModel() as any, // creativeModel
      createFakeWallet() as any, // wallet
      createFakeRollups(), // rollups (ROLLUP_READER)
      undefined, // posthog
      listingModel, // listingModel
      jobModel, // jobModel
      rollupModel as any, // rollupModel
      postModel, // postModel
      undefined, // pricingConfig
      undefined, // profileModel
      rfqModel, // rfqModel
    );

    const rows = await svc.list(OWNER);

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    // listing -> title + first image
    expect(byId['camp-L'].sourceTitle).toBe('Zari saree');
    expect(byId['camp-L'].sourceImage).toBe('cover-1.jpg');
    // listing with no images -> title, null image
    expect(byId['camp-L2'].sourceTitle).toBe('Thread cones');
    expect(byId['camp-L2'].sourceImage).toBeNull();
    // job -> title, no image
    expect(byId['camp-J'].sourceTitle).toBe('Karigar needed');
    expect(byId['camp-J'].sourceImage).toBeNull();
    // rfq -> title, no image
    expect(byId['camp-R'].sourceTitle).toBe('Need 5000m cotton');
    expect(byId['camp-R'].sourceImage).toBeNull();
    // post -> trimmed body snippet (truncated + ellipsis), no image
    expect(byId['camp-P'].sourceTitle).toBe(`${'x'.repeat(60)}…`);
    expect(byId['camp-P'].sourceImage).toBeNull();

    // BATCHED: each source model is queried with ONE find({ _id: { $in: [...] } })
    // across the whole page -- not one findById per row.
    expect(listingModel.find).toHaveBeenCalledTimes(1);
    expect(listingModel._findCalls[0]).toEqual({ _id: { $in: ['listing-1', 'listing-2'] } });
    expect(jobModel.find).toHaveBeenCalledTimes(1);
    expect(jobModel._findCalls[0]).toEqual({ _id: { $in: ['job-1'] } });
    expect(rfqModel.find).toHaveBeenCalledTimes(1);
    expect(postModel.find).toHaveBeenCalledTimes(1);
  });

  it('returns null sourceTitle / sourceImage when the source doc is missing', async () => {
    const campaigns = [
      {
        _id: 'camp-missing',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_listing',
        objective: 'reach',
        status: 'active',
        totalBudget: 500,
        budgetSpent: 0,
        startAt: new Date(),
        endAt: new Date(),
        sourceListingId: 'deleted-listing',
      },
    ];

    const campaignModel = createFakeListCampaignModel(campaigns);
    const rollupModel = createFakeRollupModel([]);
    // The listing find returns no docs (source was deleted).
    const listingModel = createFakeSourceTitleModel([]);

    const svc = new BoostService(
      campaignModel,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
      undefined,
      listingModel,
      undefined, // jobModel
      rollupModel as any,
      undefined, // postModel
      undefined, // pricingConfig
      undefined, // profileModel
      undefined, // rfqModel
    );

    const rows = await svc.list(OWNER);

    expect(rows).toHaveLength(1);
    expect(rows[0].sourceTitle).toBeNull();
    expect(rows[0].sourceImage).toBeNull();
  });

  it('resolves a profile boost title from the owner profile headline (no image)', async () => {
    const campaigns = [
      {
        _id: 'camp-otw',
        ownerUserId: new Types.ObjectId(OWNER),
        kind: 'boost_open_to_work',
        objective: 'reach',
        status: 'active',
        totalBudget: 500,
        budgetSpent: 0,
        startAt: new Date(),
        endAt: new Date(),
        sourceProfileUserId: OWNER,
      },
    ];

    const campaignModel = createFakeListCampaignModel(campaigns);
    const rollupModel = createFakeRollupModel([]);
    const profileModel = createFakeSourceTitleModel([
      { userId: new Types.ObjectId(OWNER), headline: 'Zari karigar · 12 yrs' },
    ]);

    const svc = new BoostService(
      campaignModel,
      createFakeAdSetModel() as any,
      createFakeCreativeModel() as any,
      createFakeWallet() as any,
      createFakeRollups(),
      undefined,
      undefined, // listingModel
      undefined, // jobModel
      rollupModel as any,
      undefined, // postModel
      undefined, // pricingConfig
      profileModel, // profileModel
      undefined, // rfqModel
    );

    const rows = await svc.list(OWNER);

    expect(rows[0].sourceTitle).toBe('Zari karigar · 12 yrs');
    expect(rows[0].sourceImage).toBeNull();
    expect(profileModel.find).toHaveBeenCalledTimes(1);
  });
});

// Satisfy the import reference for ROLLUP_READER token -- just ensure it is defined
describe('ROLLUP_READER token', () => {
  it('is a non-empty string', () => {
    expect(typeof ROLLUP_READER).toBe('string');
    expect(ROLLUP_READER.length).toBeGreaterThan(0);
  });
});
