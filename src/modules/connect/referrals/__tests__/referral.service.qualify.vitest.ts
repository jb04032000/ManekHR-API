/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (User / ConnectReferral) skip vitest's reflect-metadata pipeline.
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

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { ReferralService } from '../services/referral.service';

/**
 * Unit coverage for `ReferralService.onProfileCreated` (Phase 4a, Task 9: qualify
 * on activation). On CONNECT_PROFILE_CREATED for a referee with a `pending` row:
 *   - status -> qualified, qualifiedAt set, amounts snapshotted from live config;
 *   - no pending row -> no-op;
 *   - never throws (DB fault swallowed);
 *   - missing userId -> no lookup.
 * Models + config service are mocked.
 */

const REFEREE_ID = new Types.ObjectId();

const CFG = {
  enabled: true,
  referrerCredits: 60,
  refereeCredits: 40,
  holdbackDays: 7,
  perReferrerCap: 0,
  monthlyPerReferrerCap: 0,
  annualCreditCeilingPerUser: 19000,
  totalBudgetCap: 0,
  dailyVelocityPerReferrer: 10,
};

function build(cfg: any = CFG) {
  const configService: any = { getConfig: vi.fn().mockResolvedValue(cfg) };
  const userModel: any = {};
  const referralModel: any = {
    findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
  };
  // Phase 4b added two constructor deps; this 4a spec never exercises them, but
  // they are required positionally, so pass inert mocks.
  const wallet: any = { creditReferral: vi.fn(), adjust: vi.fn() };
  const audit: any = { logEvent: vi.fn() };
  // ConnectProfile model: schema-only token, not exercised by the event path.
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
  return { service, configService, userModel, referralModel };
}

beforeEach(() => vi.clearAllMocks());

describe('ReferralService.onProfileCreated', () => {
  it('qualifies a pending row: status + qualifiedAt + snapshotted amounts', async () => {
    const f = build();
    const save = vi.fn().mockResolvedValue(undefined);
    const row: any = {
      status: 'pending',
      referrerCreditAmount: 0,
      refereeCreditAmount: 0,
      qualifiedAt: undefined,
      save,
    };
    f.referralModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));

    await f.service.onProfileCreated({ userId: REFEREE_ID.toHexString() });

    // Looks up the referee's PENDING row.
    const filter = f.referralModel.findOne.mock.calls[0][0];
    expect(filter.refereeUserId).toBe(REFEREE_ID.toHexString());
    expect(filter.status).toBe('pending');

    expect(row.status).toBe('qualified');
    expect(row.qualifiedAt).toBeInstanceOf(Date);
    expect(row.referrerCreditAmount).toBe(60); // snapshot from live config.
    expect(row.refereeCreditAmount).toBe(40);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when there is no pending row (organic signup)', async () => {
    const f = build();
    f.referralModel.findOne = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) }));
    await expect(
      f.service.onProfileCreated({ userId: REFEREE_ID.toHexString() }),
    ).resolves.toBeUndefined();
  });

  it('ignores an event with no userId (no config read, no lookup)', async () => {
    const f = build();
    await f.service.onProfileCreated({ userId: '' } as any);
    expect(f.configService.getConfig).not.toHaveBeenCalled();
    expect(f.referralModel.findOne).not.toHaveBeenCalled();
  });

  it('NEVER throws: a DB fault during qualify is swallowed', async () => {
    const f = build();
    f.referralModel.findOne = vi.fn(() => ({
      exec: vi.fn().mockRejectedValue(new Error('mongo down')),
    }));
    await expect(
      f.service.onProfileCreated({ userId: REFEREE_ID.toHexString() }),
    ).resolves.toBeUndefined();
  });
});
