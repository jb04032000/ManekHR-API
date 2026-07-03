/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 3b — advance ELIGIBILITY CAPS (owner-configurable, OFF by default).
 *
 * Three guardrails enforced in AdvanceSalaryRequestService.createRequest, AFTER
 * the existing workspace-policy / window / current-month guards, each only when
 * the corresponding PayrollConfig.disbursementRules cap is non-null:
 *
 *   - advanceMinTenureMonths (>=0): member must have >= N months tenure from
 *     dateOfJoining. Under → BadRequest { code: 'ADVANCE_TENURE_NOT_MET' }.
 *   - advanceMaxPerYear (>=1): max advance requests per calendar year
 *     (pending|approved|paid). At/over → BadRequest { code: 'ADVANCE_MAX_PER_YEAR' }.
 *   - advanceMaxPercentOfNet (1-100): a single request may not exceed X% of the
 *     member's monthly figure (member.salaryAmount, RUPEES). requestedAmount is
 *     PAISE → /100 to compare. Over → BadRequest { code: 'ADVANCE_EXCEEDS_LIMIT' }.
 *
 * Each cap: BLOCKS when exceeded, PASSES when under, INERT when null/undefined —
 * EXCEPT the percent cap, which since 2026-07-03 (owner directive) has an
 * always-on 100%-of-salary BASELINE: a null advanceMaxPercentOfNet means "cannot
 * exceed the monthly salary", not "no limit". The salary lookup therefore always
 * runs (fail-open only when salaryAmount is missing/0).
 *
 * The @nestjs/mongoose decorator mock must precede the service import so the
 * transitive schema @Prop/@Schema/@InjectModel decorations are no-ops under vitest.
 * Links: advance-salary-request.service.ts createRequest.
 */
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

import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdvanceSalaryRequestService } from '../advance-salary-request.service';

const workspaceId = new Types.ObjectId().toHexString();
const requestedByUserId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId().toHexString();

// Current IST month/year so the D-02 current-month guard always passes. The
// service computes "today" in Asia/Kolkata; we mirror that here.
function istNow(): { month: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(new Date());
  return {
    month: Number(parts.find((p) => p.type === 'month')?.value ?? '0'),
    year: Number(parts.find((p) => p.type === 'year')?.value ?? '0'),
  };
}
const NOW = istNow();

/**
 * Build the service with mocks tuned per test.
 *
 * @param caps        the three nullable caps merged into disbursementRules.
 * @param memberDoc   what teamMemberModel.findById(...).lean().exec() resolves.
 * @param yearCount   what advanceRequestModel.countDocuments(...) resolves.
 */
function buildService(opts: {
  caps?: {
    advanceMinTenureMonths?: number | null;
    advanceMaxPerYear?: number | null;
    advanceMaxPercentOfNet?: number | null;
  };
  memberDoc?: any;
  yearCount?: number;
}) {
  const config = {
    features: { advancePayments: true },
    disbursementRules: {
      advanceRequestDay: 15,
      // any_day → window guard always open, so caps are what we're testing.
      advanceRequestPolicy: { mode: 'any_day' },
      ...(opts.caps ?? {}),
    },
  };

  const createdDoc = { _id: new Types.ObjectId(), status: 'pending' };
  const advanceRequestModel: any = {
    countDocuments: vi.fn().mockResolvedValue(opts.yearCount ?? 0),
    create: vi.fn().mockResolvedValue(createdDoc),
  };

  const payrollConfigModel: any = {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(config),
      }),
    }),
  };

  const notificationsService: any = { createNotification: vi.fn().mockResolvedValue({}) };

  const teamMemberModel: any = {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(opts.memberDoc ?? null),
        }),
      }),
      // some call sites omit .select()
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(opts.memberDoc ?? null),
      }),
    }),
  };

  const service = new AdvanceSalaryRequestService(
    advanceRequestModel,
    payrollConfigModel,
    notificationsService,
    teamMemberModel,
  );
  return { service, advanceRequestModel, teamMemberModel, createdDoc };
}

function dtoFor(requestedAmount: number) {
  return { requestedAmount, month: NOW.month, year: NOW.year } as any;
}

/** A date N months before today (for tenure tests). */
function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected BadRequestException with code ${code}, but it resolved`);
  } catch (err: any) {
    expect(err).toBeInstanceOf(BadRequestException);
    const resp = err.getResponse?.();
    expect(resp?.code).toBe(code);
  }
}

describe('advance eligibility caps - minTenure', () => {
  it('BLOCKS when tenure is under the cap', async () => {
    const { service } = buildService({
      caps: { advanceMinTenureMonths: 6 },
      // joined 2 months ago → under the 6-month cap
      memberDoc: { dateOfJoining: monthsAgo(2), salaryAmount: 30000 },
    });
    await expectCode(
      service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(100000)),
      'ADVANCE_TENURE_NOT_MET',
    );
  });

  it('PASSES when tenure meets the cap', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMinTenureMonths: 6 },
      // joined 10 months ago → satisfies the 6-month cap
      memberDoc: { dateOfJoining: monthsAgo(10), salaryAmount: 30000 },
    });
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(100000));
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });

  it('is INERT when the cap is null (zero tenure, request created)', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMinTenureMonths: null },
      memberDoc: { dateOfJoining: monthsAgo(0), salaryAmount: 30000 },
    });
    // Zero tenure would fail any cap; null cap → no tenure block. (The member
    // IS still fetched once for the always-on salary baseline cap.)
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(100000));
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });
});

describe('advance eligibility caps - maxPerYear', () => {
  it('BLOCKS when the year count is at/over the cap', async () => {
    const { service } = buildService({
      caps: { advanceMaxPerYear: 3 },
      yearCount: 3, // already at the cap
      memberDoc: { salaryAmount: 30000 },
    });
    await expectCode(
      service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(100000)),
      'ADVANCE_MAX_PER_YEAR',
    );
  });

  it('PASSES when the year count is under the cap', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMaxPerYear: 3 },
      yearCount: 2,
      memberDoc: { salaryAmount: 30000 },
    });
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(100000));
    expect(advanceRequestModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.anything(),
        teamMemberId: expect.anything(),
        year: NOW.year,
        status: { $in: ['pending', 'approved', 'paid'] },
      }),
    );
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });

  it('is INERT when the cap is null (no count query, request created)', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMaxPerYear: null },
      yearCount: 999,
      memberDoc: { salaryAmount: 30000 },
    });
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(100000));
    expect(advanceRequestModel.countDocuments).not.toHaveBeenCalled();
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });
});

describe('advance eligibility caps - maxPercentOfNet', () => {
  // member.salaryAmount = 30000 RUPEES; requestedAmount is PAISE.
  // 50% cap → max 15000 rupees = 1_500_000 paise.
  it('BLOCKS when the request exceeds X% of monthly salary', async () => {
    const { service } = buildService({
      caps: { advanceMaxPercentOfNet: 50 },
      memberDoc: { salaryAmount: 30000 },
    });
    // 16000 rupees = 1_600_000 paise > 15000 rupee cap
    await expectCode(
      service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(1_600_000)),
      'ADVANCE_EXCEEDS_LIMIT',
    );
  });

  it('PASSES when the request is within X% of monthly salary', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMaxPercentOfNet: 50 },
      memberDoc: { salaryAmount: 30000 },
    });
    // 10000 rupees = 1_000_000 paise <= 15000 rupee cap
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(1_000_000));
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the 100%-of-salary BASELINE when the cap is null', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMaxPercentOfNet: null },
      memberDoc: { salaryAmount: 30000 },
    });
    // Exactly the monthly salary (30000 rupees = 3_000_000 paise) → allowed.
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(3_000_000));
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS a request above the monthly salary even with a null cap (baseline)', async () => {
    const { service } = buildService({
      caps: { advanceMaxPercentOfNet: null },
      memberDoc: { salaryAmount: 30000 },
    });
    // 999_999 rupees >> 30000 monthly salary → baseline cap rejects.
    await expectCode(
      service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(99_999_999)),
      'ADVANCE_EXCEEDS_LIMIT',
    );
  });

  it('is INERT (skips) when the member monthly figure is unavailable (0/missing)', async () => {
    const { service, advanceRequestModel } = buildService({
      caps: { advanceMaxPercentOfNet: 50 },
      memberDoc: { salaryAmount: 0 },
    });
    // no usable monthly figure → do NOT block (fail-open per spec)
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(99_999_999));
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
  });
});

describe('advance eligibility caps - all OFF (default)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a within-salary request when all caps are null (baseline only)', async () => {
    const { service, advanceRequestModel, teamMemberModel } = buildService({
      caps: {
        advanceMinTenureMonths: null,
        advanceMaxPerYear: null,
        advanceMaxPercentOfNet: null,
      },
      memberDoc: { dateOfJoining: monthsAgo(0), salaryAmount: 30000 },
    });
    // 20000 rupees <= 30000 salary → allowed. Per-year count is never queried;
    // the member IS fetched once for the always-on salary baseline cap.
    await service.createRequest(workspaceId, requestedByUserId, teamMemberId, dtoFor(2_000_000));
    expect(advanceRequestModel.create).toHaveBeenCalledTimes(1);
    expect(advanceRequestModel.countDocuments).not.toHaveBeenCalled();
    expect(teamMemberModel.findById).toHaveBeenCalledTimes(1);
  });
});
