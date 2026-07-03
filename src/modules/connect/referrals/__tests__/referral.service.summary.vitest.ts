/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_2AM: '0 2 * * *' },
}));
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { ReferralService } from '../services/referral.service';

/**
 * Unit coverage for `ReferralService.getMyReferralSummary` (Phase 4b, Task 11):
 * ensures a code (getOrCreateMyCode), aggregates counts + earned/pending credit,
 * and joins referee names into the recent list.
 */

const USER_ID = new Types.ObjectId();
const REFEREE_A = new Types.ObjectId();
const REFEREE_B = new Types.ObjectId();

const CFG = {
  enabled: true,
  referrerCredits: 50,
  refereeCredits: 50,
  holdbackDays: 7,
  perReferrerCap: 0,
  monthlyPerReferrerCap: 0,
  annualCreditCeilingPerUser: 0,
  totalBudgetCap: 0,
  dailyVelocityPerReferrer: 10,
};

/** Fluent chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

beforeEach(() => vi.clearAllMocks());

describe('ReferralService.getMyReferralSummary', () => {
  it('returns code + config flags + counts + earned/pending + named recent list', async () => {
    const configService: any = { getConfig: vi.fn().mockResolvedValue(CFG) };

    // getOrCreateMyCode: the user already has a code (no write).
    const userModel: any = {
      findById: vi.fn(() => chain({ name: 'Rajesh', handle: null, referralCode: 'RAJEAB23' })),
      find: vi.fn(() =>
        chain([
          { _id: REFEREE_A, name: 'Asha', handle: null },
          { _id: REFEREE_B, name: '', handle: 'bhavesh' },
        ]),
      ),
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };

    const recentRows = [
      {
        refereeUserId: REFEREE_A,
        status: 'rewarded',
        createdAt: new Date('2026-06-10'),
        rewardedAt: new Date('2026-06-17'),
      },
      {
        refereeUserId: REFEREE_B,
        status: 'qualified',
        createdAt: new Date('2026-06-12'),
        qualifiedAt: new Date('2026-06-13'),
      },
    ];

    // countDocuments is called 3x (referred/rewarded/pending); aggregate 2x
    // (earned via sumRewardedCredit, pending via sumReferrerCreditByStatus).
    const referralModel: any = {
      countDocuments: vi
        .fn()
        .mockResolvedValueOnce(2) // referredCount
        .mockResolvedValueOnce(1) // rewardedCount
        .mockResolvedValueOnce(1), // pendingCount
      aggregate: vi
        .fn()
        .mockResolvedValueOnce([{ total: 50 }]) // creditsEarned
        .mockResolvedValueOnce([{ total: 50 }]), // creditsPending
      find: vi.fn(() => chain(recentRows)),
    };

    const wallet: any = { creditReferral: vi.fn(), adjust: vi.fn() };
    const audit: any = { logEvent: vi.fn() };
    const profileModel: any = {
      exists: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
    };
    const service = new ReferralService(
      configService,
      userModel,
      referralModel,
      wallet,
      audit,
      profileModel,
    );

    const summary = await service.getMyReferralSummary(USER_ID.toHexString());

    expect(summary.code).toBe('RAJEAB23');
    expect(summary.enabled).toBe(true);
    expect(summary.referrerCredits).toBe(50);
    expect(summary.refereeCredits).toBe(50);
    expect(summary.referredCount).toBe(2);
    expect(summary.rewardedCount).toBe(1);
    expect(summary.pendingCount).toBe(1);
    expect(summary.creditsEarned).toBe(50);
    expect(summary.creditsPending).toBe(50);

    // recent: newest first (as queried), names joined, falls back to handle then 'Member'.
    expect(summary.recent).toHaveLength(2);
    expect(summary.recent[0]).toEqual({
      name: 'Asha',
      status: 'rewarded',
      date: new Date('2026-06-17'), // rewardedAt preferred.
    });
    expect(summary.recent[1]).toEqual({
      name: 'bhavesh', // empty name -> handle.
      status: 'qualified',
      date: new Date('2026-06-13'), // qualifiedAt preferred over createdAt.
    });
  });

  it('returns an empty recent list (and no user join) when the user has no referrals', async () => {
    const configService: any = { getConfig: vi.fn().mockResolvedValue(CFG) };
    const userModel: any = {
      findById: vi.fn(() => chain({ name: 'Solo', handle: null, referralCode: 'SOLOAB23' })),
      find: vi.fn(() => chain([])),
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const referralModel: any = {
      countDocuments: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue([]),
      find: vi.fn(() => chain([])),
    };
    const wallet: any = { creditReferral: vi.fn(), adjust: vi.fn() };
    const audit: any = { logEvent: vi.fn() };
    const profileModel: any = {
      exists: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
    };
    const service = new ReferralService(
      configService,
      userModel,
      referralModel,
      wallet,
      audit,
      profileModel,
    );

    const summary = await service.getMyReferralSummary(USER_ID.toHexString());
    expect(summary.referredCount).toBe(0);
    expect(summary.creditsEarned).toBe(0);
    expect(summary.creditsPending).toBe(0);
    expect(summary.recent).toEqual([]);
    // No referee ids -> no User.find for the join.
    expect(userModel.find).not.toHaveBeenCalled();
  });
});
