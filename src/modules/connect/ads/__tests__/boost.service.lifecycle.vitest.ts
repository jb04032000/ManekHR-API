/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose so transitive schema imports do not trip reflect-metadata.
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
import { BoostService } from '../services/boost.service';

/**
 * Bucket 2/3 lifecycle coverage: the shared refund tail (completeCampaign) uses
 * the split-aware release; the account-purge forfeit tail (forfeitCampaign) frees
 * the reserve with NO credit; and stopForListing/Job/Rfq only stop when the
 * source can no longer serve. Models + wallet mocked — no Mongo.
 */

const OWNER = '0123456789abcdef01234567';

/** A model whose findById(id) resolves a Mongoose-like doc with `.save()`. */
function docModel(doc: any) {
  return {
    findById: vi.fn(() => Promise.resolve(doc)),
    findOne: vi.fn(() => Promise.resolve(doc)),
  };
}

function makeCampaign(over: Partial<any> = {}) {
  return {
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(OWNER),
    status: 'active',
    totalBudget: 500,
    budgetSpent: 100,
    reservedFromGrant: 240,
    reservedFromBalance: 160,
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

/** Build BoostService with the given campaign + wallet, and optional source models. */
function makeSvc(opts: {
  campaign?: any;
  wallet?: any;
  postModel?: any;
  listingModel?: any;
  jobModel?: any;
  rfqModel?: any;
}) {
  const campaignModel = opts.campaign
    ? docModel(opts.campaign)
    : { findById: vi.fn(() => Promise.resolve(null)), findOne: vi.fn(() => Promise.resolve(null)) };
  const wallet = opts.wallet ?? {
    release: vi.fn(),
    forfeitReserve: vi.fn(),
    reserveDetailed: vi.fn(),
  };
  const svc = new BoostService(
    campaignModel as any, // campaignModel
    undefined as any, // adSetModel
    undefined as any, // creativeModel
    wallet, // wallet
    undefined as any, // rollups
    undefined, // posthog
    opts.listingModel, // listingModel
    opts.jobModel, // jobModel
    undefined, // rollupModel
    opts.postModel, // postModel
    undefined, // pricingConfig
    undefined, // profileModel
    opts.rfqModel, // rfqModel
  );
  return { svc, campaignModel, wallet };
}

describe('BoostService — refund tail (completeCampaign via stopForListing)', () => {
  it('releases the unspent to the ORIGIN buckets (split-aware) and completes', async () => {
    const campaign = makeCampaign(); // unspent = 400 (240 grant + 160 balance)
    const wallet = { release: vi.fn().mockResolvedValue(undefined) };
    const listing = {
      _id: 'L1',
      status: 'paused', // no longer servable
      moderationStatus: 'approved',
      boostCampaignId: campaign._id,
    };
    const { svc } = makeSvc({ campaign, wallet, listingModel: docModel(listing) });

    await svc.stopForListing('L1');

    // Released the FULL unspent with the campaign's tracked grant/balance split.
    expect(wallet.release).toHaveBeenCalledWith(
      String(campaign.ownerUserId),
      400,
      String(campaign._id),
      { fromGrant: 240, fromBalance: 160 },
    );
    expect(campaign.status).toBe('completed');
    expect(campaign.reservedFromGrant).toBe(0);
    expect(campaign.reservedFromBalance).toBe(0);
  });

  it('no-ops when the listing still serves (active + approved)', async () => {
    const campaign = makeCampaign();
    const wallet = { release: vi.fn() };
    const listing = {
      _id: 'L1',
      status: 'active',
      moderationStatus: 'approved',
      boostCampaignId: campaign._id,
    };
    const { svc } = makeSvc({ campaign, wallet, listingModel: docModel(listing) });

    await svc.stopForListing('L1');

    expect(wallet.release).not.toHaveBeenCalled();
    expect(campaign.status).toBe('active');
  });

  it('stopForJob stops a closed job', async () => {
    const campaign = makeCampaign();
    const wallet = { release: vi.fn().mockResolvedValue(undefined) };
    const job = { _id: 'J1', status: 'closed', boostCampaignId: campaign._id };
    const { svc } = makeSvc({ campaign, wallet, jobModel: docModel(job) });

    await svc.stopForJob('J1');

    expect(wallet.release).toHaveBeenCalled();
    expect(campaign.status).toBe('completed');
  });

  it('stopForRfq no-ops on an open RFQ', async () => {
    const campaign = makeCampaign();
    const wallet = { release: vi.fn() };
    const rfq = { _id: 'R1', status: 'open', boostCampaignId: campaign._id };
    const { svc } = makeSvc({ campaign, wallet, rfqModel: docModel(rfq) });

    await svc.stopForRfq('R1');

    expect(wallet.release).not.toHaveBeenCalled();
  });
});

describe('BoostService — forfeit tail (stopForPost hard-deleted post)', () => {
  it('forfeits the reserve (no credit) + completes with budgetSpent = totalBudget', async () => {
    const campaign = makeCampaign(); // unspent tracked = 400
    const wallet = { forfeitReserve: vi.fn().mockResolvedValue(undefined) };
    // postModel.findById returns null (post row is GONE — hard delete); campaign
    // is found by the sourcePostId lookup (findOne).
    const postModel = { findById: vi.fn(() => Promise.resolve(null)) };
    const campaignModel = { findOne: vi.fn(() => Promise.resolve(campaign)) };
    const svc = new BoostService(
      campaignModel as any,
      undefined as any,
      undefined as any,
      wallet as any,
      undefined as any,
      undefined,
      undefined as any,
      undefined as any,
      undefined,
      postModel as any,
      undefined,
      undefined,
      undefined as any,
    );

    await svc.stopForPost(new Types.ObjectId().toHexString());

    // Forfeited the tracked reserve — NO wallet.release (no credit back).
    expect(wallet.forfeitReserve).toHaveBeenCalledWith(
      String(campaign.ownerUserId),
      400,
      String(campaign._id),
      expect.stringContaining('forfeit'),
    );
    expect(campaign.status).toBe('completed');
    expect(campaign.budgetSpent).toBe(campaign.totalBudget); // reads fully-spent
  });
});
