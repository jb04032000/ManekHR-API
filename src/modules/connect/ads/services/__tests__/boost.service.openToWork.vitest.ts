/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService.createOpenToWorkBoost unit tests -- strict TDD.
 *
 * The ad unit is the advertiser's OWN profile (no artifact doc), so the gates are
 * (1) the caller's `openTo.work` must be on and (2) no in-flight boost of this
 * kind already exists for the caller (a direct campaign query, not an artifact's
 * boostCampaignId). Mirrors boost.service.job.vitest.ts for the bundle/reserve path.
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
import type { CreateOpenToWorkBoostInput, RollupReader } from '../boost.service';

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

const OWNER = '64a000000000000000000001';

/** Campaign model fake: chainable findOne (in-flight gate) + create/deleteOne (bundle). */
function createFakeCampaignModel(inFlight: { _id: string } | null = null) {
  const created: any[] = [];
  const deletedIds: string[] = [];
  return {
    _created: created,
    _deletedIds: deletedIds,
    create(data: Record<string, any>) {
      const doc = { _id: makeId(), save: vi.fn().mockResolvedValue(undefined), ...data };
      created.push(doc);
      return Promise.resolve(doc);
    },
    deleteOne(filter: Record<string, any>) {
      deletedIds.push(String(filter._id));
      return Promise.resolve({ deletedCount: 1 });
    },
    // CN-ADS-1: buildBundleAndReserve $inc's the reserve split onto the campaign.
    updateOne(_filter: Record<string, any>, _update: Record<string, any>) {
      return Promise.resolve({ modifiedCount: 1 });
    },
    findOne() {
      return { select: () => ({ lean: () => Promise.resolve(inFlight) }) };
    },
  };
}

function createFakeBundleModel() {
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

/** Profile model fake: findOne().select().lean() -> {openTo} | null. */
function createFakeProfileModel(openTo: Record<string, boolean> | undefined) {
  return {
    findOne() {
      return {
        select: () => ({
          lean: () => Promise.resolve(openTo === undefined ? null : { openTo }),
        }),
      };
    },
  };
}

const BASE: CreateOpenToWorkBoostInput = {
  ownerUserId: OWNER,
  objective: 'reach',
  totalBudget: 500,
  days: 7,
  targeting: { roles: [], sectors: [], districts: [], companySizes: [] },
};

function buildService(opts: {
  openTo?: Record<string, boolean>;
  reserve?: boolean;
  inFlight?: { _id: string } | null;
  posthog?: { capture: ReturnType<typeof vi.fn> };
  noProfileModel?: boolean;
}) {
  const campaignModel = createFakeCampaignModel(opts.inFlight ?? null);
  const adSetModel = createFakeBundleModel();
  const creativeModel = createFakeBundleModel();
  const wallet = createFakeWallet(opts.reserve ?? true);
  // Distinguish "no profile row" (openTo explicitly undefined) from "key absent"
  // (default to work:true) -- `??` would wrongly turn an explicit undefined into
  // the default, masking the no-profile gate.
  const profileModel = opts.noProfileModel
    ? undefined
    : createFakeProfileModel('openTo' in opts ? opts.openTo : { work: true });

  const svc = new BoostService(
    campaignModel as any, // campaignModel
    adSetModel as any, // adSetModel
    creativeModel as any, // creativeModel
    wallet as any, // wallet
    createFakeRollups(), // rollups
    opts.posthog as any, // posthog
    undefined as any, // listingModel
    undefined as any, // jobModel
    undefined, // rollupModel
    undefined, // postModel
    undefined, // pricingConfig
    profileModel as any, // profileModel
  );
  return { svc, campaignModel, adSetModel, creativeModel, wallet };
}

describe('BoostService.createOpenToWorkBoost', () => {
  it('openTo.work on: creates boost_open_to_work + promoted_open_to_work on feed_promoted_profile, reserves', async () => {
    const { svc, adSetModel, creativeModel, wallet } = buildService({ openTo: { work: true } });

    const result = await svc.createOpenToWorkBoost({ ...BASE });

    expect(result.kind).toBe('boost_open_to_work');
    expect(result.billingEvent).toBe('cpm');
    // Publish-then-moderate: a launched boost serves immediately (active).
    expect(result.status).toBe('active');
    expect(String(result.sourceProfileUserId)).toBe(OWNER);

    expect(adSetModel._created[0].placements).toEqual(['feed_sponsored']);
    // Default audience: employers, since the advertiser left roles empty.
    expect(adSetModel._created[0].targeting.roles).toEqual(['workshop_owner', 'buyer']);

    const creative = creativeModel._created[0];
    expect(creative.kind).toBe('promoted_open_to_work');
    expect(String(creative.profileRef)).toBe(OWNER);
    expect(creative.postRef).toBeUndefined();

    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 500, String(result._id));
  });

  it('profile_visits objective: billingEvent cpc', async () => {
    const { svc } = buildService({ openTo: { work: true } });
    const result = await svc.createOpenToWorkBoost({ ...BASE, objective: 'profile_visits' });
    expect(result.billingEvent).toBe('cpc');
  });

  it('keeps advertiser-supplied roles (does not overwrite with the employer default)', async () => {
    const { svc, adSetModel } = buildService({ openTo: { work: true } });
    await svc.createOpenToWorkBoost({
      ...BASE,
      targeting: { roles: ['buyer'], sectors: [], districts: [], companySizes: [] },
    });
    expect(adSetModel._created[0].targeting.roles).toEqual(['buyer']);
  });

  it('openTo.work off: BadRequestException, no campaign created', async () => {
    const { svc, adSetModel } = buildService({ openTo: { work: false } });
    await expect(svc.createOpenToWorkBoost({ ...BASE })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('no profile at all: BadRequestException', async () => {
    const { svc } = buildService({ openTo: undefined });
    await expect(svc.createOpenToWorkBoost({ ...BASE })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('an in-flight open-to-work boost already exists: BadRequestException', async () => {
    const { svc, adSetModel } = buildService({
      openTo: { work: true },
      inFlight: { _id: makeId() },
    });
    await expect(svc.createOpenToWorkBoost({ ...BASE })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(adSetModel._created).toHaveLength(0);
  });

  it('wallet reserve fails: BadRequestException, all 3 docs cleaned up', async () => {
    const { svc, campaignModel, adSetModel, creativeModel } = buildService({
      openTo: { work: true },
      reserve: false,
    });
    await expect(svc.createOpenToWorkBoost({ ...BASE })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(campaignModel._deletedIds).toHaveLength(1);
    expect(adSetModel._deletedIds).toHaveLength(1);
    expect(creativeModel._deletedIds).toHaveLength(1);
  });

  it('emits ads.boost_created with target=open_to_work', async () => {
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ openTo: { work: true }, posthog });
    const result = await svc.createOpenToWorkBoost({ ...BASE });
    expect(posthog.capture).toHaveBeenCalledOnce();
    const call = posthog.capture.mock.calls[0][0];
    expect(call.properties.target).toBe('open_to_work');
    expect(call.properties.campaignId).toBe(String(result._id));
  });
});
