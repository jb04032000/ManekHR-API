/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose + @nestjs/schedule BEFORE importing the service so the
// transitive schema imports skip vitest's reflect-metadata pipeline and the
// @Cron decorator is a no-op (no scheduler is registered in a unit test).
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
 * Unit coverage for `ReferralService.releaseHeldReferrals` + `capRejectionReason`
 * (Phase 4b, Task 10). Exercises: disabled -> no-op; holdback cutoff query; both
 * sides credited with the right keys + ledger ids stored + status flip; 0-amount
 * side skipped; each cap/budget branch rejects; idempotent retry (a row that
 * stays qualified after a fault is credited exactly once on the next run via the
 * wallet keys); one bad row does not abort the batch.
 */

const REFERRER_ID = new Types.ObjectId();
const REFEREE_ID = new Types.ObjectId();
const ROW_ID = new Types.ObjectId();
const LEDGER_R = new Types.ObjectId();
const LEDGER_E = new Types.ObjectId();

const BASE_CFG = {
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

const NOW = new Date('2026-06-18T00:00:00.000Z');

/** A qualified referral row whose holdback has elapsed. */
function makeRow(overrides: any = {}) {
  return {
    _id: ROW_ID,
    referrerUserId: REFERRER_ID,
    refereeUserId: REFEREE_ID,
    status: 'qualified',
    referrerCreditAmount: 50,
    refereeCreditAmount: 50,
    qualifiedAt: new Date('2026-06-01T00:00:00.000Z'),
    referrerLedgerId: undefined,
    refereeLedgerId: undefined,
    rewardedAt: undefined,
    rejectionReason: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function build(cfg: any = BASE_CFG, dueRows: any[] = []) {
  const configService: any = { getConfig: vi.fn().mockResolvedValue(cfg) };
  const userModel: any = {};
  const referralModel: any = {
    find: vi.fn(() => ({
      sort: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(dueRows) })),
    })),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue([]),
  };
  const wallet: any = {
    creditReferral: vi.fn(),
    adjust: vi.fn(),
  };
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
  return { service, configService, userModel, referralModel, wallet, audit };
}

beforeEach(() => vi.clearAllMocks());

describe('ReferralService.releaseHeldReferrals', () => {
  it('is a no-op when the program is disabled (never pays out)', async () => {
    const f = build({ ...BASE_CFG, enabled: false });
    await f.service.releaseHeldReferrals(NOW);
    expect(f.referralModel.find).not.toHaveBeenCalled();
    expect(f.wallet.creditReferral).not.toHaveBeenCalled();
  });

  it('scans qualified rows past the holdback cutoff, oldest first', async () => {
    const f = build(BASE_CFG, []);
    await f.service.releaseHeldReferrals(NOW);
    const filter = f.referralModel.find.mock.calls[0][0];
    expect(filter.status).toBe('qualified');
    // cutoff = now - 7 days.
    const cutoff = filter.qualifiedAt.$lte as Date;
    expect(cutoff.getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it('credits BOTH sides with the right keys, stores ledger ids, flips to rewarded', async () => {
    const row = makeRow();
    const f = build(BASE_CFG, [row]);
    f.wallet.creditReferral
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_R), balanceAfter: 50 }) // referrer
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_E), balanceAfter: 50 }); // referee

    await f.service.releaseHeldReferrals(NOW);

    expect(f.wallet.creditReferral).toHaveBeenCalledTimes(2);
    const [referrerCall, refereeCall] = f.wallet.creditReferral.mock.calls;
    expect(referrerCall[0]).toBe(String(REFERRER_ID));
    expect(referrerCall[1]).toBe(50);
    expect(referrerCall[2].idempotencyKey).toBe(`referral:${String(ROW_ID)}:referrer`);
    expect(referrerCall[2].referralId).toBe(String(ROW_ID));
    expect(referrerCall[2].recordedBy).toBe('system');
    expect(refereeCall[0]).toBe(String(REFEREE_ID));
    expect(refereeCall[2].idempotencyKey).toBe(`referral:${String(ROW_ID)}:referee`);

    expect(String(row.referrerLedgerId)).toBe(String(LEDGER_R));
    expect(String(row.refereeLedgerId)).toBe(String(LEDGER_E));
    expect(row.status).toBe('rewarded');
    expect(row.rewardedAt).toBe(NOW);
    expect(row.save).toHaveBeenCalled();
  });

  it('skips a side whose snapshotted amount is 0 (still credits the other)', async () => {
    const row = makeRow({ refereeCreditAmount: 0 });
    const f = build(BASE_CFG, [row]);
    f.wallet.creditReferral.mockResolvedValue({ ledgerId: String(LEDGER_R), balanceAfter: 50 });

    await f.service.releaseHeldReferrals(NOW);

    expect(f.wallet.creditReferral).toHaveBeenCalledTimes(1); // referrer only.
    expect(f.wallet.creditReferral.mock.calls[0][2].idempotencyKey).toContain(':referrer');
    expect(row.refereeLedgerId).toBeUndefined();
    expect(row.status).toBe('rewarded');
  });

  it('rejects (no credit) when the lifetime perReferrerCap is hit', async () => {
    const row = makeRow();
    const f = build({ ...BASE_CFG, perReferrerCap: 3 }, [row]);
    f.referralModel.countDocuments = vi.fn().mockResolvedValue(3); // lifetime rewarded == cap.

    await f.service.releaseHeldReferrals(NOW);

    expect(f.wallet.creditReferral).not.toHaveBeenCalled();
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('cap_exceeded');
  });

  it('rejects when the monthlyPerReferrerCap is hit', async () => {
    const row = makeRow();
    const f = build({ ...BASE_CFG, monthlyPerReferrerCap: 2 }, [row]);
    // First countDocuments call is the (skipped) lifetime check guard? No -- lifetime
    // cap is 0 (skipped). The monthly check is the first countDocuments call.
    f.referralModel.countDocuments = vi.fn().mockResolvedValue(2); // this month == cap.

    await f.service.releaseHeldReferrals(NOW);

    expect(f.wallet.creditReferral).not.toHaveBeenCalled();
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('cap_exceeded');
  });

  it('rejects when adding this row would breach the per-user annual FY ceiling', async () => {
    const row = makeRow({ referrerCreditAmount: 50 });
    const f = build({ ...BASE_CFG, annualCreditCeilingPerUser: 100 }, [row]);
    // Σ rewarded referrer credit this FY = 60; 60 + 50 > 100 -> reject.
    f.referralModel.aggregate = vi.fn().mockResolvedValue([{ total: 60 }]);

    await f.service.releaseHeldReferrals(NOW);

    expect(f.wallet.creditReferral).not.toHaveBeenCalled();
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('cap_exceeded');
  });

  it('rejects with budget_exceeded when the program total budget would breach', async () => {
    const row = makeRow({ referrerCreditAmount: 50, refereeCreditAmount: 50 });
    const f = build({ ...BASE_CFG, totalBudgetCap: 120 }, [row]);
    // Σ all rewarded credit program-wide = 80; 80 + 100 > 120 -> budget_exceeded.
    f.referralModel.aggregate = vi.fn().mockResolvedValue([{ total: 80 }]);

    await f.service.releaseHeldReferrals(NOW);

    expect(f.wallet.creditReferral).not.toHaveBeenCalled();
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('budget_exceeded');
  });

  it('is idempotent across runs: a still-qualified row is credited exactly once via the keys', async () => {
    // Run 1: referrer credit succeeds, referee credit throws -> row stays qualified,
    // batch not aborted. Run 2: wallet keys make the referrer credit a no-op return
    // of the SAME ledger, referee now succeeds -> row rewarded. Money lands once.
    const row = makeRow();

    // Run 1
    const f1 = build(BASE_CFG, [row]);
    f1.wallet.creditReferral
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_R), balanceAfter: 50 }) // referrer ok
      .mockRejectedValueOnce(new Error('wallet blip')); // referee fails
    await f1.service.releaseHeldReferrals(NOW);
    expect(row.status).toBe('qualified'); // not flipped -- safe to retry.

    // Run 2 -- same row object, both keyed credits return (referrer no-op, referee ok).
    const f2 = build(BASE_CFG, [row]);
    f2.wallet.creditReferral
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_R), balanceAfter: 50 }) // referrer no-op (same ledger)
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_E), balanceAfter: 50 }); // referee ok
    await f2.service.releaseHeldReferrals(NOW);
    expect(row.status).toBe('rewarded');
    expect(String(row.referrerLedgerId)).toBe(String(LEDGER_R));
    expect(String(row.refereeLedgerId)).toBe(String(LEDGER_E));
  });

  it('one bad row does not abort the batch (the next row still processes)', async () => {
    const badRow = makeRow({ _id: new Types.ObjectId(), save: vi.fn() });
    const goodRow = makeRow({
      _id: new Types.ObjectId(),
      save: vi.fn().mockResolvedValue(undefined),
    });
    const f = build(BASE_CFG, [badRow, goodRow]);
    // Bad row: first credit throws. Good row: both credits succeed.
    f.wallet.creditReferral
      .mockRejectedValueOnce(new Error('boom')) // badRow referrer
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_R), balanceAfter: 50 }) // goodRow referrer
      .mockResolvedValueOnce({ ledgerId: String(LEDGER_E), balanceAfter: 50 }); // goodRow referee

    await f.service.releaseHeldReferrals(NOW);

    expect(badRow.status).toBe('qualified'); // left for retry.
    expect(goodRow.status).toBe('rewarded');
  });
});
