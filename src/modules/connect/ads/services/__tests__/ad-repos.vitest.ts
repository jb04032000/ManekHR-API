/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * TDD tests for ad-repos.ts (Task 32).
 *
 * All Mongoose models are replaced with plain in-process fakes.
 * No real DB or network calls.
 *
 * Covered classes:
 *   - PlacementRepoMongo
 *   - CandidateRepoMongo
 *   - ImpressionOpenerMongo
 *   - ImpressionRepoMongo
 *   - CampaignSpendRepoMongo
 *   - ClickRepoMongo
 *   - RollupReaderMongo
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
import { Types } from 'mongoose';

import {
  PlacementRepoMongo,
  CandidateRepoMongo,
  ImpressionOpenerMongo,
  ImpressionRepoMongo,
  CampaignSpendRepoMongo,
  ClickRepoMongo,
  RollupReaderMongo,
  CROSS_SELL_RAIL_PLACEMENTS,
} from '../ad-repos';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObjectId(): Types.ObjectId {
  return new Types.ObjectId();
}

function makeIdStr(): string {
  return makeObjectId().toHexString();
}

/**
 * Default User model fake for CandidateRepoMongo (Demo-Content Scope B hard
 * gate). `find().select().lean()` resolves to `owners` — pass demo owners here
 * to prove the auction excludes them; default [] means "no demo owners", so the
 * gate is a no-op and pre-existing candidate tests behave exactly as before.
 */
function makeUserModel(owners: Array<{ _id: any; isDemo?: boolean; email?: string }> = []) {
  return {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: () => Promise.resolve(owners) }),
    }),
  };
}

// CN-ADS-6 (feed harden): CandidateRepoMongo.top now batch-loads campaigns +
// creatives with `find({_id/campaignId:{$in}}).lean()` (was findOne per adSet)
// and scans adSets with `find().limit().lean()`. These fakes mirror the new
// chains. `adSetFake` adds the `.limit()` link; `findInFake` serves the batched
// `$in` reads from a fixed array (the repo joins them in memory by id).
function adSetFake(rows: any[]) {
  const chain = { limit: vi.fn(() => chain), lean: () => Promise.resolve(rows) };
  return { find: vi.fn(() => chain) };
}
function findInFake(rows: any[]) {
  return { find: vi.fn().mockReturnValue({ lean: () => Promise.resolve(rows) }) };
}

// ---------------------------------------------------------------------------
// PlacementRepoMongo
// ---------------------------------------------------------------------------

describe('PlacementRepoMongo.get', () => {
  it('maps a found doc to Placement shape', async () => {
    const raw = {
      key: 'feed_promoted_post',
      surface: 'feed',
      floorCpm: 5,
      enabled: true,
    };
    const placementModel = {
      findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(raw) }),
    };

    const repo = new PlacementRepoMongo(placementModel as any);
    const result = await repo.get('feed_promoted_post');

    expect(result).toEqual({
      key: 'feed_promoted_post',
      surface: 'feed',
      floorCpm: 5,
      enabled: true,
    });
    expect(placementModel.findOne).toHaveBeenCalledWith({ key: 'feed_promoted_post' });
  });

  it('returns null when doc is not found', async () => {
    const placementModel = {
      findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    };

    const repo = new PlacementRepoMongo(placementModel as any);
    const result = await repo.get('nonexistent');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CandidateRepoMongo.top
// ---------------------------------------------------------------------------

describe('CandidateRepoMongo.top', () => {
  const now = new Date();
  const campaignIdObj = makeObjectId();
  const adSetId1 = makeObjectId();
  const adSetId2 = makeObjectId();
  const creativeId = makeObjectId();
  const ownerUserId = makeObjectId();
  const postRefId = makeObjectId();

  const activeAdSet = {
    _id: adSetId1,
    campaignId: campaignIdObj,
    targeting: { roles: ['worker'], sectors: ['textile'], districts: [], companySizes: [] },
    placements: ['feed_promoted_post'],
    freqCapCount: 3,
    freqCapWindowSec: 86400,
  };

  const pausedAdSet = {
    _id: adSetId2,
    campaignId: makeObjectId(),
    targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    placements: ['feed_promoted_post'],
    freqCapCount: 5,
    freqCapWindowSec: 3600,
  };

  const activeCampaign = {
    _id: campaignIdObj,
    ownerUserId,
    status: 'active',
    startAt: new Date(now.getTime() - 1000),
    endAt: new Date(now.getTime() + 86400000),
    budgetSpent: 100,
    totalBudget: 500,
    billingEvent: 'cpm',
    bid: 40,
  };

  const approvedCreative = {
    _id: creativeId,
    campaignId: campaignIdObj,
    reviewStatus: 'approved',
    kind: 'promoted_post',
    postRef: postRefId,
  };

  it('includes candidate from active in-budget campaign with approved creative; excludes paused campaign adset', async () => {
    const adSetModel = adSetFake([activeAdSet, pausedAdSet]);

    // The batched campaign query bakes in the eligibility predicate, so only the
    // ELIGIBLE campaign (activeCampaign) comes back; the paused adSet's campaign
    // is filtered out by the query (absent from the returned array).
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([approvedCreative]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    const result = await repo.top('feed_promoted_post', 10);

    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.campaignId).toBe(String(campaignIdObj));
    expect(c.adSetId).toBe(String(adSetId1));
    expect(c.creativeId).toBe(String(creativeId));
    expect(c.authorUserId).toBe(String(ownerUserId));
    expect(c.creativeKind).toBe('promoted_post');
    expect(c.postRef).toBe(String(postRefId));
    expect(c.billingEvent).toBe('cpm');
    expect(c.bid).toBe(40);
    expect(c.predictedCtr).toBe(0.01);
    expect(c.relevance).toBe(1);
    expect(c.targeting).toEqual(activeAdSet.targeting);
    expect(c.freqCapCount).toBe(3);
    expect(c.freqCapWindowSec).toBe(86400);
  });

  it('maps a promoted_listing creative to creativeKind + listingRef (no postRef)', async () => {
    const listingRefId = makeObjectId();
    const listingCreative = {
      _id: creativeId,
      campaignId: campaignIdObj,
      reviewStatus: 'approved',
      kind: 'promoted_listing',
      listingRef: listingRefId,
    };
    const adSetModel = adSetFake([activeAdSet]);
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([listingCreative]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    const result = await repo.top('marketplace_rail', 10);

    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.creativeKind).toBe('promoted_listing');
    expect(c.listingRef).toBe(String(listingRefId));
    expect(c.postRef).toBeUndefined();
  });

  it('excludes adset whose creative is not approved', async () => {
    const adSetModel = adSetFake([activeAdSet]);
    const campaignModel = findInFake([activeCampaign]);

    // creativeModel.findOne with reviewStatus:'approved' returns null (not approved)
    const creativeModel2 = findInFake([]);

    const repo2 = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel2 as any,
      makeUserModel() as any,
    );

    const result = await repo2.top('feed_promoted_post', 10);
    expect(result).toHaveLength(0);
  });

  it('excludes adset whose campaign is over-budget', async () => {
    // campaignModel returns null because the $expr budgetSpent < totalBudget guard
    // rejects the over-budget campaign at the DB query level.
    const adSetModel = adSetFake([activeAdSet]);
    // Campaign model returns null because $expr budgetSpent < totalBudget fails (handled upstream in findOne)
    const campaignModel = findInFake([]);
    const creativeModel = findInFake([approvedCreative]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    const result = await repo.top('feed_promoted_post', 10);
    expect(result).toHaveLength(0);
  });

  it('campaign query includes status:active + date range + $expr budget guard', async () => {
    const adSetModel = adSetFake([activeAdSet]);
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([approvedCreative]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    await repo.top('feed_promoted_post', 10);

    expect(campaignModel.find).toHaveBeenCalled();
    const callArg = campaignModel.find.mock.calls[0][0];
    // Must include status: 'active'
    expect(callArg.status).toBe('active');
    // Must include date range guards
    expect(callArg.startAt).toBeDefined();
    expect(callArg.endAt).toBeDefined();
    // Must include $expr budget guard
    expect(callArg.$expr).toBeDefined();
  });

  it('budget guard requires remaining > 0 AND remaining >= the floor price', async () => {
    const adSetModel = adSetFake([activeAdSet]);
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([approvedCreative]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    // floorCpm 8 -> minRemainingCredits = 8/1000 = 0.008.
    await repo.top('feed_promoted_post', 10, 0.008);

    const callArg = campaignModel.find.mock.calls[0][0];
    expect(callArg.$expr).toEqual({
      $and: [
        { $gt: [{ $subtract: ['$totalBudget', '$budgetSpent'] }, 0] },
        { $gte: [{ $subtract: ['$totalBudget', '$budgetSpent'] }, 0.008] },
      ],
    });
  });

  it('sorts results by bid descending', async () => {
    const adSet1 = { ...activeAdSet, _id: makeObjectId(), campaignId: makeObjectId() };
    const adSet2 = { ...activeAdSet, _id: makeObjectId(), campaignId: makeObjectId() };

    const camp1 = { ...activeCampaign, _id: adSet1.campaignId, bid: 10 };
    const camp2 = { ...activeCampaign, _id: adSet2.campaignId, bid: 30 };

    const creative1 = { ...approvedCreative, campaignId: adSet1.campaignId };
    const creative2 = { ...approvedCreative, campaignId: adSet2.campaignId };

    const adSetModel = adSetFake([adSet1, adSet2]);
    // Batched: the campaign query returns BOTH eligible campaigns; the repo joins
    // them to their adSets in memory and sorts the resulting candidates by bid.
    const campaignModel = findInFake([camp1, camp2]);
    const creativeModel = findInFake([creative1, creative2]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    const result = await repo.top('feed_promoted_post', 10);

    expect(result).toHaveLength(2);
    // Higher bid (30) should come first
    expect(result[0].bid).toBe(30);
    expect(result[1].bid).toBe(10);
  });

  it('respects the limit parameter', async () => {
    const adSets = Array.from({ length: 5 }, () => ({
      ...activeAdSet,
      _id: makeObjectId(),
      campaignId: makeObjectId(),
    }));
    // One eligible campaign + approved creative per adSet, joined in memory.
    const campaigns = adSets.map((s) => ({
      ...activeCampaign,
      _id: s.campaignId,
      bid: Math.random() * 100,
    }));
    const creatives = adSets.map((s) => ({ ...approvedCreative, campaignId: s.campaignId }));

    const adSetModel = adSetFake(adSets);
    const campaignModel = findInFake(campaigns);
    const creativeModel = findInFake(creatives);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    const result = await repo.top('feed_promoted_post', 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Demo/sample hard gate (Demo-Content Scope B). A demo-owned campaign is
  // INELIGIBLE for the auction outright (not down-ranked) so demo content never
  // enters a paid/sponsored slot or gets billed. Marker = owner User.isDemo OR
  // @connect-demo.zari360.test email.
  // -------------------------------------------------------------------------

  it('excludes a candidate whose owner User.isDemo is true', async () => {
    const adSetModel = adSetFake([activeAdSet]);
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([approvedCreative]);

    // Owner of the only candidate is flagged isDemo -> dropped.
    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel([{ _id: ownerUserId, isDemo: true }]) as any,
    );

    const result = await repo.top('feed_promoted_post', 10);
    expect(result).toHaveLength(0);
  });

  it('excludes a candidate whose owner email ends with @connect-demo.zari360.test', async () => {
    const adSetModel = adSetFake([activeAdSet]);
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([approvedCreative]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel([{ _id: ownerUserId, email: 'seed1@connect-demo.zari360.test' }]) as any,
    );

    const result = await repo.top('feed_promoted_post', 10);
    expect(result).toHaveLength(0);
  });

  it('keeps a real-owner candidate (owner not demo) and drops only the demo one', async () => {
    const realAdSet = { ...activeAdSet, _id: makeObjectId(), campaignId: makeObjectId() };
    const demoAdSet = { ...activeAdSet, _id: makeObjectId(), campaignId: makeObjectId() };
    const realOwner = makeObjectId();
    const demoOwner = makeObjectId();
    const realCampaign = {
      ...activeCampaign,
      _id: realAdSet.campaignId,
      ownerUserId: realOwner,
      bid: 10,
    };
    const demoCampaign = {
      ...activeCampaign,
      _id: demoAdSet.campaignId,
      ownerUserId: demoOwner,
      bid: 99,
    };

    const adSetModel = adSetFake([realAdSet, demoAdSet]);
    // Both campaigns are query-eligible; the demo owner is dropped later by the
    // demo hard gate (batched User lookup), not by the campaign query.
    const campaignModel = findInFake([realCampaign, demoCampaign]);
    const creativeModel = findInFake([
      { ...approvedCreative, campaignId: realAdSet.campaignId },
      { ...approvedCreative, _id: makeObjectId(), campaignId: demoAdSet.campaignId },
    ]);

    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel([{ _id: demoOwner, isDemo: true }]) as any,
    );

    const result = await repo.top('feed_promoted_post', 10);
    // Demo owner had the higher bid (99) but is excluded outright; only the real
    // owner's candidate survives.
    expect(result).toHaveLength(1);
    expect(result[0].authorUserId).toBe(String(realOwner));
  });
});

// ---------------------------------------------------------------------------
// CandidateRepoMongo.top -- platform-wide cross-sell rail eligibility (Wave 2)
//
// A listing boost binds only the canonical keys (marketplace_grid /
// marketplace_rail / feed_sponsored). These tests prove an EXISTING such boost
// is eligible on a cross-sell rail key (e.g. company_page) WITHOUT binding it,
// while non-listing boosts and exact-key (non-cross-sell) placements are
// unaffected. Targeting / budget / floor / self-view / leak gates are enforced
// downstream (ad-decision.service + the public web getter) and are unchanged.
// ---------------------------------------------------------------------------

describe('CandidateRepoMongo.top -- cross-sell rail eligibility', () => {
  const now = new Date();
  const canonicalCampaignId = makeObjectId();
  const canonicalAdSetId = makeObjectId();
  const canonicalCreativeId = makeObjectId();
  const ownerUserId = makeObjectId();
  const listingRefId = makeObjectId();

  // An EXISTING listing boost: AdSet bound ONLY to the canonical listing keys
  // (exactly what boost.service.createListingBoost writes). It does NOT bind
  // company_page or any other cross-sell key.
  const listingAdSet = {
    _id: canonicalAdSetId,
    campaignId: canonicalCampaignId,
    targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
    placements: ['marketplace_grid', 'marketplace_rail', 'feed_sponsored'],
    freqCapCount: 3,
    freqCapWindowSec: 86400,
  };
  const activeCampaign = {
    _id: canonicalCampaignId,
    ownerUserId,
    status: 'active',
    startAt: new Date(now.getTime() - 1000),
    endAt: new Date(now.getTime() + 86400000),
    budgetSpent: 100,
    totalBudget: 500,
    billingEvent: 'cpm',
    bid: 40,
  };
  const listingCreative = {
    _id: canonicalCreativeId,
    campaignId: canonicalCampaignId,
    reviewStatus: 'approved',
    kind: 'promoted_listing',
    listingRef: listingRefId,
  };

  function build(adSetsForQuery: any[], creative = listingCreative) {
    const adSetModel = adSetFake(adSetsForQuery);
    const campaignModel = findInFake([activeCampaign]);
    const creativeModel = findInFake([creative]);
    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );
    return { repo, adSetModel };
  }

  it('serves an existing listing boost on a cross-sell rail (company_page) WITHOUT binding that key', async () => {
    const { repo, adSetModel } = build([listingAdSet]);

    const result = await repo.top('company_page', 10);

    // The widened query matches AdSets bound to the canonical listing keys too.
    const filter = adSetModel.find.mock.calls[0][0];
    expect(filter.placements.$in).toEqual(
      expect.arrayContaining(['company_page', 'marketplace_grid', 'marketplace_rail']),
    );

    expect(result).toHaveLength(1);
    expect(result[0].creativeKind).toBe('promoted_listing');
    expect(result[0].listingRef).toBe(String(listingRefId));
    expect(result[0].campaignId).toBe(String(canonicalCampaignId));
  });

  it('every cross-sell rail key widens the lookup and serves the listing boost', async () => {
    for (const key of CROSS_SELL_RAIL_PLACEMENTS) {
      const { repo, adSetModel } = build([listingAdSet]);
      const result = await repo.top(key, 10);
      const filter = adSetModel.find.mock.calls[0][0];
      expect(filter.placements.$in, `key ${key} should widen`).toContain(key);
      expect(result, `key ${key} should serve the listing boost`).toHaveLength(1);
      expect(result[0].creativeKind).toBe('promoted_listing');
    }
  });

  it('drops a non-listing boost from a cross-sell rail even if its AdSet matched the widened lookup', async () => {
    // A job boost whose AdSet somehow bound a canonical key: the widened query
    // returns it, but the promoted_listing-only filter excludes it so a
    // cross-sell rail never serves a non-listing card.
    const jobCreative = {
      _id: makeObjectId(),
      campaignId: canonicalCampaignId,
      reviewStatus: 'approved',
      kind: 'promoted_job',
      jobRef: makeObjectId(),
    };
    const jobAdSet = { ...listingAdSet, placements: ['marketplace_rail'] };
    const { repo } = build([jobAdSet], jobCreative);

    const result = await repo.top('company_page', 10);
    expect(result).toHaveLength(0);
  });

  it('does NOT widen a non-cross-sell key (marketplace_rail keeps the strict exact-key match)', async () => {
    const { repo, adSetModel } = build([listingAdSet]);
    await repo.top('marketplace_rail', 10);

    const filter = adSetModel.find.mock.calls[0][0];
    // Exact-key match, not an $in widening.
    expect(filter).toEqual({ placements: 'marketplace_rail' });
  });

  it('a listing boost still does NOT appear on a non-cross-sell key it did not bind (e.g. jobs_rail)', async () => {
    // jobs_rail is NOT a cross-sell key, so the strict { placements: 'jobs_rail' }
    // match returns no AdSets (this boost only bound the marketplace/feed keys).
    const { repo, adSetModel } = build([]);
    const result = await repo.top('jobs_rail', 10);
    expect(adSetModel.find.mock.calls[0][0]).toEqual({ placements: 'jobs_rail' });
    expect(result).toHaveLength(0);
  });

  it('cross-sell candidate still carries the budget guard so an over-budget campaign is excluded', async () => {
    // Campaign query returns EMPTY (the $expr budget guard rejected it upstream):
    // an over-budget listing boost is excluded on a cross-sell rail too.
    const adSetModel = adSetFake([listingAdSet]);
    const campaignModel = findInFake([]);
    const creativeModel = findInFake([listingCreative]);
    const repo = new CandidateRepoMongo(
      adSetModel as any,
      campaignModel as any,
      creativeModel as any,
      makeUserModel() as any,
    );

    const result = await repo.top('company_page', 10, 0.05);
    expect(result).toHaveLength(0);
    // The budget $expr guard is still applied to the cross-sell candidate.
    expect(campaignModel.find.mock.calls[0][0].$expr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ImpressionOpenerMongo.open
// ---------------------------------------------------------------------------

describe('ImpressionOpenerMongo.open', () => {
  it('creates impression with viewable=false, charged=false, chargeAmount=0 and returns impressionToken', async () => {
    const impressionModel = {
      create: vi.fn().mockResolvedValue({}),
    };

    const repo = new ImpressionOpenerMongo(impressionModel as any);
    const input = {
      campaignId: makeIdStr(),
      adSetId: makeIdStr(),
      creativeId: makeIdStr(),
      userId: makeIdStr(),
      placementKey: 'feed_promoted_post',
    };

    const result = await repo.open(input);

    expect(result.impressionToken).toBeDefined();
    expect(typeof result.impressionToken).toBe('string');
    expect(result.impressionToken.length).toBeGreaterThan(0);

    expect(impressionModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: input.campaignId,
        adSetId: input.adSetId,
        creativeId: input.creativeId,
        userId: input.userId,
        placementKey: input.placementKey,
        viewable: false,
        charged: false,
        chargeAmount: 0,
      }),
    );

    // Token in create call matches returned token
    const createArg = impressionModel.create.mock.calls[0][0];
    expect(createArg.impressionToken).toBe(result.impressionToken);
  });
});

// ---------------------------------------------------------------------------
// ImpressionRepoMongo
// ---------------------------------------------------------------------------

describe('ImpressionRepoMongo.findOne', () => {
  const impressionToken = 'tok-abc-123';
  const campaignIdObj = makeObjectId();

  const viewerObj = makeObjectId();
  const rawImpression = {
    impressionToken,
    campaignId: campaignIdObj,
    adSetId: makeObjectId(),
    userId: viewerObj,
    charged: false,
  };

  const rawCampaign = {
    _id: campaignIdObj,
    ownerUserId: makeObjectId(),
    billingEvent: 'cpm',
    bid: 40,
  };

  it('returns ImpressionView joining impression + campaign fields including ownerUserId/billingEvent/bid', async () => {
    const impressionModel = {
      findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(rawImpression) }),
    };
    const campaignModel = {
      findById: vi.fn().mockReturnValue({ lean: () => Promise.resolve(rawCampaign) }),
    };

    const repo = new ImpressionRepoMongo(impressionModel as any, campaignModel as any);
    const result = await repo.findOne(impressionToken);

    expect(result).not.toBeNull();
    expect(result.impressionToken).toBe(impressionToken);
    expect(result.campaignId).toBe(String(campaignIdObj));
    expect(result.ownerUserId).toBe(String(rawCampaign.ownerUserId));
    expect(result.billingEvent).toBe('cpm');
    expect(result.bid).toBe(40);
    expect(result.charged).toBe(false);
    // viewerUserId is surfaced for the self-impression guard.
    expect(result.viewerUserId).toBe(String(viewerObj));

    expect(impressionModel.findOne).toHaveBeenCalledWith({ impressionToken });
    expect(campaignModel.findById).toHaveBeenCalledWith(rawImpression.campaignId);
  });

  it('returns null when impression is not found', async () => {
    const impressionModel = {
      findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    };
    const campaignModel = {
      findById: vi.fn(),
    };

    const repo = new ImpressionRepoMongo(impressionModel as any, campaignModel as any);
    const result = await repo.findOne('unknown-token');

    expect(result).toBeNull();
    expect(campaignModel.findById).not.toHaveBeenCalled();
  });

  it('returns null when campaign is not found', async () => {
    const impressionModel = {
      findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(rawImpression) }),
    };
    const campaignModel = {
      findById: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    };

    const repo = new ImpressionRepoMongo(impressionModel as any, campaignModel as any);
    const result = await repo.findOne(impressionToken);

    expect(result).toBeNull();
  });
});

describe('ImpressionRepoMongo.setViewableAndCharge', () => {
  it('returns true when findOneAndUpdate finds and updates a doc', async () => {
    const updatedDoc = {
      impressionToken: 'tok-1',
      viewable: true,
      charged: true,
      chargeAmount: 0.04,
    };
    const impressionModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue(updatedDoc),
    };
    const campaignModel = { findById: vi.fn() };

    const repo = new ImpressionRepoMongo(impressionModel as any, campaignModel as any);
    const result = await repo.setViewableAndCharge('tok-1', 0.04);

    expect(result).toBe(true);
    expect(impressionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { impressionToken: 'tok-1', charged: false },
      { $set: { viewable: true, charged: true, chargeAmount: 0.04 } },
      { new: true },
    );
  });

  it('returns false when findOneAndUpdate returns null (already charged / lost race)', async () => {
    const impressionModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    };
    const campaignModel = { findById: vi.fn() };

    const repo = new ImpressionRepoMongo(impressionModel as any, campaignModel as any);
    const result = await repo.setViewableAndCharge('tok-already-charged', 0.04);

    expect(result).toBe(false);
  });
});

describe('ImpressionRepoMongo.clearCharge', () => {
  it('resets chargeAmount to 0 without touching the charged flag', async () => {
    const impressionModel = { updateOne: vi.fn().mockResolvedValue({}) };
    const campaignModel = { findById: vi.fn() };

    const repo = new ImpressionRepoMongo(impressionModel as any, campaignModel as any);
    await repo.clearCharge('tok-1');

    expect(impressionModel.updateOne).toHaveBeenCalledWith(
      { impressionToken: 'tok-1' },
      { $set: { chargeAmount: 0 } },
    );
  });
});

// ---------------------------------------------------------------------------
// CampaignSpendRepoMongo
// ---------------------------------------------------------------------------

describe('CampaignSpendRepoMongo.tryConsumeBudget', () => {
  it('guarded $inc: matches only while budgetSpent + amount <= totalBudget', async () => {
    const campaignModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'camp-123', budgetSpent: 0.04 }),
    };

    const repo = new CampaignSpendRepoMongo(campaignModel as any);
    const ok = await repo.tryConsumeBudget('camp-123', 0.04);

    expect(ok).toBe(true);
    const [filter, update] = campaignModel.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe('camp-123');
    expect(filter.$expr).toEqual({ $lte: [{ $add: ['$budgetSpent', 0.04] }, '$totalBudget'] });
    expect(update).toEqual({ $inc: { budgetSpent: 0.04 } });
  });

  it('returns false when the guard fails (no budget headroom)', async () => {
    const campaignModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    };

    const repo = new CampaignSpendRepoMongo(campaignModel as any);
    const ok = await repo.tryConsumeBudget('camp-123', 0.04);

    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClickRepoMongo
// ---------------------------------------------------------------------------

describe('ClickRepoMongo.createIfAbsent', () => {
  it('returns true when create succeeds (first click)', async () => {
    const clickModel = {
      create: vi.fn().mockResolvedValue({}),
    };

    const repo = new ClickRepoMongo(clickModel as any);
    const result = await repo.createIfAbsent('tok-x', {
      impressionToken: 'tok-x',
      campaignId: 'camp-1',
      userId: 'user-1',
      valid: true,
      clickedAt: new Date(),
      chargeAmount: 4,
    });

    expect(result).toBe(true);
    expect(clickModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ impressionToken: 'tok-x', campaignId: 'camp-1' }),
    );
  });

  it('returns false when create throws a duplicate key error (code 11000)', async () => {
    const dupErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const clickModel = {
      create: vi.fn().mockRejectedValue(dupErr),
    };

    const repo = new ClickRepoMongo(clickModel as any);
    const result = await repo.createIfAbsent('tok-dup', {
      impressionToken: 'tok-dup',
      campaignId: 'camp-1',
      userId: 'user-1',
      valid: true,
      clickedAt: new Date(),
      chargeAmount: 4,
    });

    expect(result).toBe(false);
  });

  it('rethrows non-duplicate errors', async () => {
    const otherErr = new Error('DB connection lost');
    const clickModel = {
      create: vi.fn().mockRejectedValue(otherErr),
    };

    const repo = new ClickRepoMongo(clickModel as any);

    await expect(
      repo.createIfAbsent('tok-err', {
        impressionToken: 'tok-err',
        campaignId: 'camp-1',
        userId: 'user-1',
        valid: true,
        clickedAt: new Date(),
        chargeAmount: 4,
      }),
    ).rejects.toThrow('DB connection lost');
  });

  it('persists invalidReason when the click is invalid', async () => {
    const clickModel = { create: vi.fn().mockResolvedValue({}) };
    const repo = new ClickRepoMongo(clickModel as any);

    await repo.createIfAbsent('tok-bad', {
      impressionToken: 'tok-bad',
      campaignId: 'camp-1',
      userId: 'user-1',
      valid: false,
      invalidReason: 'self_click',
      clickedAt: new Date(),
      chargeAmount: 0,
    });

    expect(clickModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ valid: false, invalidReason: 'self_click' }),
    );
  });
});

describe('ClickRepoMongo.countByUserCampaignSince', () => {
  it('counts clicks by user + campaign with clickedAt >= since', async () => {
    const since = new Date('2026-06-11T00:00:00Z');
    const clickModel = { countDocuments: vi.fn().mockResolvedValue(3) };
    const repo = new ClickRepoMongo(clickModel as any);

    const n = await repo.countByUserCampaignSince('user-1', 'camp-1', since);

    expect(n).toBe(3);
    expect(clickModel.countDocuments).toHaveBeenCalledWith({
      userId: 'user-1',
      campaignId: 'camp-1',
      clickedAt: { $gte: since },
    });
  });
});

describe('ClickRepoMongo.setChargeAmount', () => {
  it('updates chargeAmount on the click row by token', async () => {
    const clickModel = { updateOne: vi.fn().mockResolvedValue({}) };
    const repo = new ClickRepoMongo(clickModel as any);

    await repo.setChargeAmount('tok-1', 0);

    expect(clickModel.updateOne).toHaveBeenCalledWith(
      { impressionToken: 'tok-1' },
      { $set: { chargeAmount: 0 } },
    );
  });
});

// ---------------------------------------------------------------------------
// RollupReaderMongo
// ---------------------------------------------------------------------------

describe('RollupReaderMongo.aggregateFor', () => {
  // RollupReaderMongo casts the incoming string to Types.ObjectId for the
  // $match so Mongo uses the compound index correctly. Tests must pass valid
  // 24-char hex strings (as they always are in production).
  const validCampaignId = makeIdStr();

  it('maps impression + click aggregate buckets to metric object', async () => {
    const impressionAgg = [{ _id: null, impressions: 1200, viewableImpressions: 900, spend: 48 }];
    const clickAgg = [{ _id: null, clicks: 45, validClicks: 40 }];

    const impressionModel = {
      aggregate: vi.fn().mockResolvedValue(impressionAgg),
    };
    const clickModel = {
      aggregate: vi.fn().mockResolvedValue(clickAgg),
    };

    const repo = new RollupReaderMongo(impressionModel as any, clickModel as any);
    const result = await repo.aggregateFor(validCampaignId);

    expect(result.impressions).toBe(1200);
    expect(result.viewableImpressions).toBe(900);
    expect(result.spend).toBe(48);
    expect(result.clicks).toBe(45);
    expect(result.validClicks).toBe(40);
  });

  it('returns all zeros when both aggregates are empty (no matching docs)', async () => {
    const impressionModel = {
      aggregate: vi.fn().mockResolvedValue([]),
    };
    const clickModel = {
      aggregate: vi.fn().mockResolvedValue([]),
    };

    const repo = new RollupReaderMongo(impressionModel as any, clickModel as any);
    const result = await repo.aggregateFor(validCampaignId);

    expect(result).toEqual({
      impressions: 0,
      viewableImpressions: 0,
      clicks: 0,
      validClicks: 0,
      spend: 0,
    });
  });

  it('calls impressionModel.aggregate with $match on campaignId (as ObjectId) and correct $group', async () => {
    const impressionModel = {
      aggregate: vi.fn().mockResolvedValue([]),
    };
    const clickModel = {
      aggregate: vi.fn().mockResolvedValue([]),
    };

    const repo = new RollupReaderMongo(impressionModel as any, clickModel as any);
    await repo.aggregateFor(validCampaignId);

    expect(impressionModel.aggregate).toHaveBeenCalledTimes(1);
    const pipeline = impressionModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toBeDefined();
    // campaignId in $match must be an ObjectId instance (not a raw string)
    expect(pipeline[0].$match.campaignId).toBeInstanceOf(Types.ObjectId);
    expect(pipeline[0].$match.campaignId.toHexString()).toBe(validCampaignId);
    expect(pipeline[1].$group).toBeDefined();
    expect(pipeline[1].$group.impressions).toBeDefined();
    expect(pipeline[1].$group.viewableImpressions).toBeDefined();
    expect(pipeline[1].$group.spend).toBeDefined();
  });

  it('calls clickModel.aggregate with $match on campaignId (as ObjectId) and correct $group', async () => {
    const impressionModel = {
      aggregate: vi.fn().mockResolvedValue([]),
    };
    const clickModel = {
      aggregate: vi.fn().mockResolvedValue([]),
    };

    const repo = new RollupReaderMongo(impressionModel as any, clickModel as any);
    await repo.aggregateFor(validCampaignId);

    expect(clickModel.aggregate).toHaveBeenCalledTimes(1);
    const pipeline = clickModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toBeDefined();
    // campaignId in $match must be an ObjectId instance
    expect(pipeline[0].$match.campaignId).toBeInstanceOf(Types.ObjectId);
    expect(pipeline[0].$match.campaignId.toHexString()).toBe(validCampaignId);
    expect(pipeline[1].$group).toBeDefined();
    expect(pipeline[1].$group.clicks).toBeDefined();
    expect(pipeline[1].$group.validClicks).toBeDefined();
  });
});
