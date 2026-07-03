/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * BoostService.createHiringBoost unit tests -- strict TDD.
 *
 * Profile/intent-level hiring boost (no specific job post). Gates: `openTo.hiring`
 * on + no in-flight boost_hiring for the caller. Default audience = workers.
 * Mirrors boost.service.openToWork.vitest.ts.
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
import type { CreateHiringBoostInput, RollupReader } from '../boost.service';

function makeId(): string {
  return new Types.ObjectId().toHexString();
}

const OWNER = '64a000000000000000000001';

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

const BASE: CreateHiringBoostInput = {
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
}) {
  const campaignModel = createFakeCampaignModel(opts.inFlight ?? null);
  const adSetModel = createFakeBundleModel();
  const creativeModel = createFakeBundleModel();
  const wallet = createFakeWallet(opts.reserve ?? true);
  const profileModel = createFakeProfileModel(opts.openTo ?? { hiring: true });

  const svc = new BoostService(
    campaignModel as any,
    adSetModel as any,
    creativeModel as any,
    wallet as any,
    createFakeRollups(),
    opts.posthog as any,
    undefined as any,
    undefined as any,
    undefined,
    undefined,
    undefined,
    profileModel as any,
  );
  return { svc, campaignModel, adSetModel, creativeModel, wallet };
}

describe('BoostService.createHiringBoost', () => {
  it('openTo.hiring on: creates boost_hiring + promoted_hiring on feed_promoted_profile with worker default audience', async () => {
    const { svc, adSetModel, creativeModel, wallet } = buildService({ openTo: { hiring: true } });

    const result = await svc.createHiringBoost({ ...BASE });

    expect(result.kind).toBe('boost_hiring');
    expect(result.billingEvent).toBe('cpm');
    expect(String(result.sourceProfileUserId)).toBe(OWNER);
    expect(adSetModel._created[0].placements).toEqual(['feed_sponsored']);
    expect(adSetModel._created[0].targeting.roles).toEqual(['karigar']);
    expect(creativeModel._created[0].kind).toBe('promoted_hiring');
    expect(String(creativeModel._created[0].profileRef)).toBe(OWNER);
    expect(wallet.reserveDetailed).toHaveBeenCalledWith(OWNER, 500, String(result._id));
  });

  it('openTo.hiring off: BadRequestException, no campaign created', async () => {
    const { svc, adSetModel } = buildService({ openTo: { hiring: false } });
    await expect(svc.createHiringBoost({ ...BASE })).rejects.toBeInstanceOf(BadRequestException);
    expect(adSetModel._created).toHaveLength(0);
  });

  it('an in-flight hiring boost already exists: BadRequestException', async () => {
    const { svc, adSetModel } = buildService({
      openTo: { hiring: true },
      inFlight: { _id: makeId() },
    });
    await expect(svc.createHiringBoost({ ...BASE })).rejects.toBeInstanceOf(BadRequestException);
    expect(adSetModel._created).toHaveLength(0);
  });

  it('wallet reserve fails: BadRequestException, all 3 docs cleaned up', async () => {
    const { svc, campaignModel, adSetModel, creativeModel } = buildService({
      openTo: { hiring: true },
      reserve: false,
    });
    await expect(svc.createHiringBoost({ ...BASE })).rejects.toBeInstanceOf(BadRequestException);
    expect(campaignModel._deletedIds).toHaveLength(1);
    expect(adSetModel._deletedIds).toHaveLength(1);
    expect(creativeModel._deletedIds).toHaveLength(1);
  });

  it('emits ads.boost_created with target=hiring', async () => {
    const posthog = { capture: vi.fn() };
    const { svc } = buildService({ openTo: { hiring: true }, posthog });
    await svc.createHiringBoost({ ...BASE });
    expect(posthog.capture.mock.calls[0][0].properties.target).toBe('hiring');
  });
});
