/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
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

import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ReferralService } from '../services/referral.service';

/**
 * Unit coverage for the admin surface (Phase 4b, Task 12):
 *  - listReferrals: paginated, filtered by status/referrer, newest first.
 *  - clawback: a REWARDED row reverses both credited sides via wallet.adjust
 *    (negative), flips to rejected/manual_clawback, and audits; a NON-rewarded
 *    row flips + audits WITHOUT any wallet reversal.
 */

const REFERRER_ID = new Types.ObjectId();
const REFEREE_ID = new Types.ObjectId();
const ROW_ID = new Types.ObjectId();
const LEDGER_R = new Types.ObjectId();
const LEDGER_E = new Types.ObjectId();
const ADMIN_ID = new Types.ObjectId();

function build() {
  const configService: any = { getConfig: vi.fn() };
  const userModel: any = {};
  const referralModel: any = {
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({ exec: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    })),
    countDocuments: vi.fn().mockResolvedValue(0),
    findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
    // CN-REF-1 claim-before-move: the atomic per-side claim. Default stub honours
    // the `{ [field]: { $ne: true } }` guard against a stored row (set via
    // `_row`), returning the row on a successful claim (flag was unset) and null
    // when the flag is already true. Individual tests can override.
    _row: null as any,
    findOneAndUpdate: vi.fn(function (this: any, filter: any, update: any) {
      const stored = referralModel._row;
      const field = update?.$set && Object.keys(update.$set)[0];
      // Miss when the row is already flagged for this side (claim already owned).
      if (stored && field && stored[field] === true) {
        return { exec: vi.fn().mockResolvedValue(null) };
      }
      // Claim succeeds: reflect the flip on the stored row + return it.
      if (stored && field) stored[field] = true;
      return { exec: vi.fn().mockResolvedValue(stored ?? { _id: filter?._id }) };
    }),
  };
  const wallet: any = { creditReferral: vi.fn(), adjust: vi.fn().mockResolvedValue({}) };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
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

describe('ReferralService.listReferrals', () => {
  it('returns rows + total + page + pageSize and applies status/referrer filters', async () => {
    const f = build();
    const rows = [{ _id: ROW_ID }];
    const execMock = vi.fn().mockResolvedValue(rows);
    const limitMock = vi.fn(() => ({ exec: execMock }));
    const skipMock = vi.fn(() => ({ limit: limitMock }));
    const sortMock = vi.fn(() => ({ skip: skipMock }));
    f.referralModel.find = vi.fn(() => ({ sort: sortMock }));
    f.referralModel.countDocuments = vi.fn().mockResolvedValue(42);

    const result = await f.service.listReferrals({
      status: 'rewarded',
      referrerUserId: REFERRER_ID.toHexString(),
      page: 2,
      pageSize: 10,
    });

    const filter = f.referralModel.find.mock.calls[0][0];
    expect(filter.status).toBe('rewarded');
    expect(String(filter.referrerUserId)).toBe(String(REFERRER_ID));
    expect(sortMock).toHaveBeenCalledWith({ createdAt: -1 });
    expect(skipMock).toHaveBeenCalledWith(10); // (page 2 - 1) * pageSize 10.
    expect(limitMock).toHaveBeenCalledWith(10);
    expect(result).toEqual({ rows, total: 42, page: 2, pageSize: 10 });
  });

  it('clamps page/pageSize to sane bounds and an empty filter when no params', async () => {
    const f = build();
    const result = await f.service.listReferrals({ page: 0, pageSize: 9999 });
    const filter = f.referralModel.find.mock.calls[0][0];
    expect(filter).toEqual({}); // no status / referrer.
    expect(result.page).toBe(1); // floored up to 1.
    expect(result.pageSize).toBe(100); // capped at 100.
  });
});

describe('ReferralService.clawback', () => {
  it('reverses BOTH credited sides via wallet.adjust(negative), flips state, audits', async () => {
    const f = build();
    const row: any = {
      _id: ROW_ID,
      referrerUserId: REFERRER_ID,
      refereeUserId: REFEREE_ID,
      status: 'rewarded',
      referrerCreditAmount: 50,
      refereeCreditAmount: 50,
      referrerLedgerId: LEDGER_R,
      refereeLedgerId: LEDGER_E,
      rejectionReason: undefined,
      referrerClawedBack: false,
      refereeClawedBack: false,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));
    f.referralModel._row = row; // CN-REF-1 claim-before-move sees this row's flags.

    await f.service.clawback(String(ROW_ID), 'fraud confirmed', ADMIN_ID.toHexString());

    expect(f.wallet.adjust).toHaveBeenCalledTimes(2);
    const [referrerCall, refereeCall] = f.wallet.adjust.mock.calls;
    // adjust(ownerUserId, amount, adminUserId, reason, note?) -- signed NEGATIVE.
    expect(referrerCall[0]).toBe(String(REFERRER_ID));
    expect(referrerCall[1]).toBe(-50);
    expect(referrerCall[2]).toBe(ADMIN_ID.toHexString());
    expect(referrerCall[3]).toBe('referral clawback');
    expect(refereeCall[0]).toBe(String(REFEREE_ID));
    expect(refereeCall[1]).toBe(-50);

    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('manual_clawback');
    expect(row.save).toHaveBeenCalled();
    // Both sides newly reversed -> both flags now true.
    expect(row.referrerClawedBack).toBe(true);
    expect(row.refereeClawedBack).toBe(true);

    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'ads',
        entityType: 'ConnectReferral',
        action: 'referral_clawback',
        actorId: ADMIN_ID.toHexString(),
        entityId: String(ROW_ID),
        meta: { reason: 'fraud confirmed', referrerReversed: true, refereeReversed: true },
      }),
    );
  });

  it('an already-SPENT referee credit never blocks the clawback (referrer still reversed, row flipped, audit reflects referee not reversed)', async () => {
    const f = build();
    const row: any = {
      _id: ROW_ID,
      referrerUserId: REFERRER_ID,
      refereeUserId: REFEREE_ID,
      status: 'rewarded',
      referrerCreditAmount: 50,
      refereeCreditAmount: 50,
      referrerLedgerId: LEDGER_R,
      refereeLedgerId: LEDGER_E,
      referrerClawedBack: false,
      refereeClawedBack: false,
      rejectionReason: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));
    f.referralModel._row = row;
    // Referrer reversal succeeds; referee reversal throws (credit already spent ->
    // wallet floored balance + rejected the debit with a BadRequestException).
    f.wallet.adjust = vi
      .fn()
      .mockResolvedValueOnce({}) // referrer ok
      .mockRejectedValueOnce(new BadRequestException('insufficient balance for this deduction')); // referee spent

    const result = await f.service.clawback(
      String(ROW_ID),
      'fraud confirmed',
      ADMIN_ID.toHexString(),
    );

    // Both sides were ATTEMPTED -- the already-spent one did not abort the other.
    expect(f.wallet.adjust).toHaveBeenCalledTimes(2);
    // Referrer reversed exactly once with the right negative amount.
    expect(f.wallet.adjust.mock.calls[0][0]).toBe(String(REFERRER_ID));
    expect(f.wallet.adjust.mock.calls[0][1]).toBe(-50);

    // Row still flipped despite the already-spent side.
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('manual_clawback');
    // Both sides flagged handled (the spent side is recorded as "did what we could").
    expect(row.referrerClawedBack).toBe(true);
    expect(row.refereeClawedBack).toBe(true);

    // Audit meta records referrer reversed but referee NOT reversed (was spent).
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { reason: 'fraud confirmed', referrerReversed: true, refereeReversed: false },
      }),
    );
  });

  it('is idempotent on retry: re-clawing a row whose sides are already flagged performs NO further wallet.adjust', async () => {
    const f = build();
    // A row that was already clawed back once (e.g. now `rejected`, both flags true).
    const row: any = {
      _id: ROW_ID,
      referrerUserId: REFERRER_ID,
      refereeUserId: REFEREE_ID,
      status: 'rejected',
      referrerCreditAmount: 50,
      refereeCreditAmount: 50,
      referrerLedgerId: LEDGER_R,
      refereeLedgerId: LEDGER_E,
      referrerClawedBack: true,
      refereeClawedBack: true,
      rejectionReason: 'manual_clawback',
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));
    f.referralModel._row = row; // both flags true -> the claim MISSES -> no re-debit.

    await f.service.clawback(String(ROW_ID), 'retry', ADMIN_ID.toHexString());

    // No double-debit: the per-side guards short-circuit every reversal.
    expect(f.wallet.adjust).not.toHaveBeenCalled();
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('manual_clawback');
    // Audit reflects nothing newly reversed on the retry.
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { reason: 'retry', referrerReversed: false, refereeReversed: false },
      }),
    );
  });

  it('a NON-rewarded row clawbacks WITHOUT any wallet reversal (flip + audit only)', async () => {
    const f = build();
    const row: any = {
      _id: ROW_ID,
      referrerUserId: REFERRER_ID,
      refereeUserId: REFEREE_ID,
      status: 'qualified', // never credited.
      referrerCreditAmount: 50,
      refereeCreditAmount: 50,
      referrerLedgerId: undefined,
      refereeLedgerId: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));

    await f.service.clawback(String(ROW_ID), 'precautionary', ADMIN_ID.toHexString());

    expect(f.wallet.adjust).not.toHaveBeenCalled();
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('manual_clawback');
    expect(f.audit.logEvent).toHaveBeenCalledTimes(1);
  });

  it('throws when the referral row does not exist', async () => {
    const f = build();
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) }));
    await expect(f.service.clawback(String(ROW_ID), 'x', ADMIN_ID.toHexString())).rejects.toThrow();
    expect(f.wallet.adjust).not.toHaveBeenCalled();
    expect(f.audit.logEvent).not.toHaveBeenCalled();
  });

  // ── CN-REF-1: claim-before-move durability ──────────────────────────────

  it('CN-REF-1: a genuine fault on the 2nd side leaves the 1st side DURABLY claimed (no re-debit on retry)', async () => {
    const f = build();
    const row: any = {
      _id: ROW_ID,
      referrerUserId: REFERRER_ID,
      refereeUserId: REFEREE_ID,
      status: 'rewarded',
      referrerCreditAmount: 50,
      refereeCreditAmount: 50,
      referrerLedgerId: LEDGER_R,
      refereeLedgerId: LEDGER_E,
      referrerClawedBack: false,
      refereeClawedBack: false,
      rejectionReason: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));
    f.referralModel._row = row;
    // Referrer reversal succeeds; referee reversal throws a GENUINE fault (mongo
    // down) — NOT a BadRequestException. clawback() must abort (rethrow).
    f.wallet.adjust = vi
      .fn()
      .mockResolvedValueOnce({}) // referrer ok
      .mockRejectedValueOnce(new Error('mongo connection lost')); // genuine fault

    await expect(
      f.service.clawback(String(ROW_ID), 'fraud', ADMIN_ID.toHexString()),
    ).rejects.toThrow('mongo connection lost');

    // The referrer side was CLAIMED durably (its flag committed via findOneAndUpdate
    // BEFORE the money move), so a retry will not re-debit it.
    expect(row.referrerClawedBack).toBe(true);
    // Exactly one successful adjust landed for the referrer (never re-attempted).
    expect(
      f.wallet.adjust.mock.calls.filter((c: any[]) => c[0] === String(REFERRER_ID)),
    ).toHaveLength(1);

    // Simulate the retry: findById returns the same row (referrer flag now true).
    f.wallet.adjust = vi.fn().mockResolvedValue({});
    await f.service.clawback(String(ROW_ID), 'fraud retry', ADMIN_ID.toHexString());
    // The referrer side is already claimed -> the claim MISSES -> no re-debit.
    expect(
      f.wallet.adjust.mock.calls.filter((c: any[]) => c[0] === String(REFERRER_ID)),
    ).toHaveLength(0);
  });

  it('CN-REF-1: two concurrent clawbacks on the same row adjust each side exactly once', async () => {
    const f = build();
    const row: any = {
      _id: ROW_ID,
      referrerUserId: REFERRER_ID,
      refereeUserId: REFEREE_ID,
      status: 'rewarded',
      referrerCreditAmount: 50,
      refereeCreditAmount: 50,
      referrerLedgerId: LEDGER_R,
      refereeLedgerId: LEDGER_E,
      referrerClawedBack: false,
      refereeClawedBack: false,
      rejectionReason: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    f.referralModel.findById = vi.fn(() => ({ exec: vi.fn().mockResolvedValue(row) }));
    f.referralModel._row = row; // shared stored row -> the claim guard serializes.

    await Promise.all([
      f.service.clawback(String(ROW_ID), 'c1', ADMIN_ID.toHexString()),
      f.service.clawback(String(ROW_ID), 'c2', ADMIN_ID.toHexString()),
    ]);

    // Exactly one adjust per side across BOTH concurrent calls (the atomic claim
    // let only the first caller through per side).
    expect(
      f.wallet.adjust.mock.calls.filter((c: any[]) => c[0] === String(REFERRER_ID)),
    ).toHaveLength(1);
    expect(
      f.wallet.adjust.mock.calls.filter((c: any[]) => c[0] === String(REFEREE_ID)),
    ).toHaveLength(1);
  });
});
