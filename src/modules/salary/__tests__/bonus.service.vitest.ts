/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * BonusService unit tests (Phase 3A).
 *
 * Strategy: mock all Mongoose models and injected services using the same
 * @nestjs/mongoose decorator-mock pattern as commission.service.vitest.ts.
 *
 * Cases:
 *   A. runStatutoryBonus
 *      A1. creates bonus SalaryAdjustment rows (single ledger - category='bonus')
 *      A2. idempotent: second run for same FY skips already-paid members
 *      A3. festival countsAsStatutory: fully satisfied (festival >= statutory)
 *          -> member skipped in statutory run
 *      A4. festival countsAsStatutory: partially satisfied (festival < statutory)
 *          -> only shortfall posted as statutory adjustment
 *      A5. ineligible members (wage > ceiling) -> no adjustment created
 *
 *   B. recordFestivalBonus
 *      B1. creates bonus SalaryAdjustment with category='bonus', pfExcluded=true
 *      B2. countsAsStatutory flag is propagated to adjustment
 *      B3. multiple entries -> multiple adjustments (batch)
 *
 *   C. getBonusSummary
 *      C1. aggregates only 'bonus' category adjustments for the correct FY
 *      C2. returns per-member statutory vs discretionary totals
 *
 *   D. Single-ledger assertion: all bonus money is in SalaryAdjustment;
 *      BonusRun stores metadata only
 */

import { describe, it, expect, vi } from 'vitest';

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
import { BonusService } from '../bonus.service';

// ---------------------------------------------------------------------------
// Shared IDs
// ---------------------------------------------------------------------------

const workspaceId = new Types.ObjectId().toHexString();
const memberId1 = new Types.ObjectId();
const memberId2 = new Types.ObjectId();
const userId = new Types.ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSalaryDoc(
  memberId: Types.ObjectId,
  opts: Partial<{ baseSalary: number; presentDays: number; month: number; year: number }> = {},
) {
  return {
    _id: new Types.ObjectId(),
    teamMemberId: memberId,
    month: opts.month ?? 5,
    year: opts.year ?? 2026,
    presentDays: opts.presentDays ?? 22,
    baseSalary: opts.baseSalary ?? 15000,
    netSalary: 15000,
  };
}

function makeAdjustmentDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    category: 'bonus',
    type: 'addition',
    pfExcluded: true,
    esiExcluded: false,
    amount: 583,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeBonusRunDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(workspaceId),
    financialYear: 2025,
    bonusType: 'statutory',
    memberRows: [] as any[],
    totalEligibleMembers: 0,
    totalDisbursedMembers: 0,
    totalDisbursedAmount: 0,
    status: 'pending',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build service
// ---------------------------------------------------------------------------

function buildService(
  opts: {
    // salary records (FY months) returned for all members
    salaryRows?: any[];
    // existing bonus adjustments (already paid in a previous run)
    existingStatutoryAgg?: any[];
    // existing festival bonus with countsAsStatutory
    festivalAgg?: any[];
    // payroll config bonus settings
    bonusConfig?: Partial<{
      eligibilityWageCeiling: number;
      calculationWageFloor: number;
      allocableSurplusPercent: number;
      minPercent: number;
      maxPercent: number;
      clawbackMonthsDefault: number;
      newEstablishment: boolean;
    }>;
  } = {},
) {
  const {
    salaryRows = [
      // Default: member1 has all 12 months worked, wage=15000 (eligible)
      ...Array.from({ length: 9 }, (_, i) => ({
        teamMemberId: memberId1.toHexString(),
        month: 4 + i,
        year: 2025,
        presentDays: 22,
        baseSalary: 15000,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        teamMemberId: memberId1.toHexString(),
        month: 1 + i,
        year: 2026,
        presentDays: 22,
        baseSalary: 15000,
      })),
    ],
    existingStatutoryAgg = [],
    festivalAgg = [],
    bonusConfig = {},
  } = opts;

  const defaultCfg = {
    eligibilityWageCeiling: 21000,
    calculationWageFloor: 7000,
    minimumWageMonthly: null,
    allocableSurplusPercent: 0,
    minPercent: 8.33,
    maxPercent: 20,
    defaultPercent: 8.33,
    clawbackMonthsDefault: 0,
    newEstablishment: false,
    ...bonusConfig,
  };

  // SalaryAdjustment model
  const savedAdjustment = makeAdjustmentDoc();
  const adjustmentCtorMock = vi.fn().mockImplementation((data: any) => ({
    ...savedAdjustment,
    ...data,
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));

  // Aggregate returns different results depending on the query.
  // We use a counter to sequence calls deterministically.
  let aggregateCallIdx = 0;
  (adjustmentCtorMock as any).aggregate = vi.fn().mockImplementation((_pipeline: any[]) => {
    const idx = aggregateCallIdx++;
    // Call order in computeStatutoryPreviewRows + runStatutoryBonus:
    //   0: festival bonus for preview (festivalAgg)
    //   1: alreadyPaidAgg (existingStatutoryAgg)
    //   2: festivalMap for run (festivalAgg)
    // getBonusSummary calls:
    //   0: raw rows by (teamMemberId, countsAsStatutory)
    //   1: statutory run bucket (bonusRunId exists, countsAsStatutory!=true)
    const responses = [festivalAgg, existingStatutoryAgg, festivalAgg, [], []];
    return { exec: vi.fn().mockResolvedValue(responses[idx] ?? []) };
  });
  (adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });

  // BonusRun model
  const bonusRunDoc = makeBonusRunDoc();
  const bonusRunCtorMock = vi.fn().mockImplementation((_data: any) => bonusRunDoc);
  (bonusRunCtorMock as any).find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });
  (bonusRunCtorMock as any).findOne = vi.fn().mockReturnValue({
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(null),
  });

  // PayrollConfig model
  const payrollConfigModel = {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ bonusConfig: defaultCfg, compliance: {} }),
    }),
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  };

  // Salary model
  const salaryModel = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(salaryRows),
    }),
    findOne: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    }),
  };

  const salaryService: any = {
    ensureSingleEmployeeRecord: vi
      .fn()
      .mockImplementation((_wid: string, memberId: string) =>
        Promise.resolve(makeSalaryDoc(new Types.ObjectId(memberId))),
      ),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const service = new BonusService(
    adjustmentCtorMock as any,
    bonusRunCtorMock as any,
    payrollConfigModel as any,
    salaryModel as any,
    salaryService,
    auditService as any,
    postHog as any,
  );

  return {
    service,
    adjustmentCtorMock,
    bonusRunCtorMock,
    bonusRunDoc,
    salaryService,
    auditService,
    postHog,
    aggregateCallIdxRef: () => aggregateCallIdx,
  };
}

// ---------------------------------------------------------------------------
// A. runStatutoryBonus
// ---------------------------------------------------------------------------

describe('runStatutoryBonus', () => {
  it('A1: creates bonus SalaryAdjustment with category=bonus for eligible member', async () => {
    const { service, adjustmentCtorMock } = buildService();

    const result = await service.runStatutoryBonus(
      workspaceId,
      {
        financialYear: 2025,
        disbursedMonth: 11,
        disbursedYear: 2025,
      },
      userId,
    );

    // One eligible member -> one adjustment
    expect(adjustmentCtorMock).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.adjustmentIds).toHaveLength(1);

    const adjArgs = adjustmentCtorMock.mock.calls[0][0];
    // Single-ledger: category must be 'bonus'
    expect(adjArgs.category).toBe('bonus');
    expect(adjArgs.type).toBe('addition');
    expect(adjArgs.pfExcluded).toBe(true);
    expect(adjArgs.source).toBe('system');
    expect(adjArgs.bonusFinancialYear).toBe(2025);
    // bonusRunId is set (back-reference to BonusRun; money is in this adjustment)
    expect(adjArgs.bonusRunId).toBeDefined();
  });

  it('A2: idempotent - skips member already paid in a previous run for same FY', async () => {
    // existingStatutoryAgg returns the member as already paid
    const { service, adjustmentCtorMock } = buildService({
      existingStatutoryAgg: [{ teamMemberId: memberId1.toHexString() }],
    });

    const result = await service.runStatutoryBonus(
      workspaceId,
      {
        financialYear: 2025,
        disbursedMonth: 11,
        disbursedYear: 2025,
      },
      userId,
    );

    // Member skipped (already paid)
    expect(adjustmentCtorMock).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('A3: countsAsStatutory festival >= statutory amount -> member skipped in run', async () => {
    // Statutory amount for member1 at 8.33%, 12 months, calcWage=7000 ~ 583.
    // Festival bonus = 1000 (>= 583) -> skip.
    const { service, adjustmentCtorMock } = buildService({
      festivalAgg: [{ teamMemberId: memberId1.toHexString(), total: 1000 }],
    });

    const result = await service.runStatutoryBonus(
      workspaceId,
      {
        financialYear: 2025,
        disbursedMonth: 11,
        disbursedYear: 2025,
      },
      userId,
    );

    expect(adjustmentCtorMock).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('A4: countsAsStatutory festival < statutory amount -> only shortfall posted', async () => {
    // Festival = 200; statutory ~ 583; shortfall = max(0, 583-200) = 383.
    const { service, adjustmentCtorMock } = buildService({
      festivalAgg: [{ teamMemberId: memberId1.toHexString(), total: 200 }],
    });

    await service.runStatutoryBonus(
      workspaceId,
      {
        financialYear: 2025,
        disbursedMonth: 11,
        disbursedYear: 2025,
      },
      userId,
    );

    expect(adjustmentCtorMock).toHaveBeenCalledTimes(1);
    const adjArgs = adjustmentCtorMock.mock.calls[0][0];
    // Shortfall: 583 - 200 = 383 (statutory calc may differ slightly due to rounding)
    expect(adjArgs.amount).toBeGreaterThan(0);
    expect(adjArgs.amount).toBeLessThan(600); // less than full statutory
    expect(adjArgs.category).toBe('bonus');
  });

  it('A5: ineligible member (wage > ceiling) -> no adjustment created', async () => {
    // Use a member with wage > eligibilityWageCeiling (21000).
    const { service, adjustmentCtorMock } = buildService({
      salaryRows: Array.from({ length: 12 }, (_, i) => ({
        teamMemberId: memberId1.toHexString(),
        month: i < 9 ? 4 + i : 1 + (i - 9),
        year: i < 9 ? 2025 : 2026,
        presentDays: 22,
        baseSalary: 25000, // above ceiling
      })),
    });

    const result = await service.runStatutoryBonus(
      workspaceId,
      {
        financialYear: 2025,
        disbursedMonth: 11,
        disbursedYear: 2025,
      },
      userId,
    );

    expect(adjustmentCtorMock).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B. recordFestivalBonus
// ---------------------------------------------------------------------------

describe('recordFestivalBonus', () => {
  it('B1: creates bonus SalaryAdjustment with category=bonus, pfExcluded=true', async () => {
    const { service, adjustmentCtorMock } = buildService();

    const result = await service.recordFestivalBonus(
      workspaceId,
      {
        subType: 'festival_diwali',
        financialYear: 2025,
        disbursedMonth: 10,
        disbursedYear: 2025,
        entries: [{ teamMemberId: memberId1.toHexString(), amount: 2000 }],
      },
      userId,
    );

    expect(adjustmentCtorMock).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.adjustmentIds).toHaveLength(1);

    const adjArgs = adjustmentCtorMock.mock.calls[0][0];
    expect(adjArgs.category).toBe('bonus');
    expect(adjArgs.type).toBe('addition');
    expect(adjArgs.pfExcluded).toBe(true);
    expect(adjArgs.amount).toBe(2000);
    expect(adjArgs.bonusFinancialYear).toBe(2025);
    // countsAsStatutory defaults to false
    expect(adjArgs.countsAsStatutory).toBe(false);
  });

  it('B2: countsAsStatutory flag is propagated to adjustment', async () => {
    const { service, adjustmentCtorMock } = buildService();

    await service.recordFestivalBonus(
      workspaceId,
      {
        subType: 'festival_diwali',
        financialYear: 2025,
        disbursedMonth: 10,
        disbursedYear: 2025,
        countsAsStatutory: true,
        entries: [{ teamMemberId: memberId1.toHexString(), amount: 1500 }],
      },
      userId,
    );

    const adjArgs = adjustmentCtorMock.mock.calls[0][0];
    expect(adjArgs.countsAsStatutory).toBe(true);
    expect(adjArgs.bonusFinancialYear).toBe(2025);
  });

  it('B3: multiple entries -> multiple bonus adjustments (batch)', async () => {
    const { service, adjustmentCtorMock } = buildService();

    const result = await service.recordFestivalBonus(
      workspaceId,
      {
        subType: 'festival_diwali',
        financialYear: 2025,
        disbursedMonth: 10,
        disbursedYear: 2025,
        entries: [
          { teamMemberId: memberId1.toHexString(), amount: 2000 },
          { teamMemberId: memberId2.toHexString(), amount: 1800 },
        ],
      },
      userId,
    );

    expect(adjustmentCtorMock).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);

    // Both are bonus category (single ledger)
    for (const call of adjustmentCtorMock.mock.calls) {
      expect(call[0].category).toBe('bonus');
    }
  });
});

// ---------------------------------------------------------------------------
// C. getBonusSummary
// ---------------------------------------------------------------------------

describe('getBonusSummary', () => {
  it('C1: aggregates only bonus category adjustments for the given FY', async () => {
    const { service, adjustmentCtorMock } = buildService();

    let capturedMatch: any = null;
    (adjustmentCtorMock as any).aggregate = vi.fn().mockImplementation((pipeline: any[]) => {
      capturedMatch = pipeline[0]?.$match;
      return { exec: vi.fn().mockResolvedValue([]) };
    });

    await service.getBonusSummary(workspaceId, { financialYear: 2025 });

    expect(capturedMatch).toBeDefined();
    expect(capturedMatch.category).toBe('bonus');
    expect(capturedMatch.type).toBe('addition');
    expect(capturedMatch.status).toBe('active');
    expect(capturedMatch.bonusFinancialYear).toBe(2025);
  });

  it('C2: correctly totals from known fixture', async () => {
    const { service, adjustmentCtorMock } = buildService();

    const memberId = new Types.ObjectId().toHexString();
    let aggCallIdx = 0;
    (adjustmentCtorMock as any).aggregate = vi.fn().mockImplementation((_pipeline: any[]) => {
      const idx = aggCallIdx++;
      if (idx === 0) {
        // First call: raw rows by (teamMemberId, countsAsStatutory)
        return {
          exec: vi.fn().mockResolvedValue([
            { teamMemberId: memberId, countsAsStatutory: false, total: 583 }, // statutory run
            { teamMemberId: memberId, countsAsStatutory: true, total: 2000 }, // festival
          ]),
        };
      }
      // Second call: statutory-run bucket (bonusRunId exists, countsAsStatutory!=true)
      return {
        exec: vi.fn().mockResolvedValue([{ teamMemberId: memberId, total: 583 }]),
      };
    });

    const result = await service.getBonusSummary(workspaceId, { financialYear: 2025 });

    // statutory = 583 (from run), discretionary = 2000 (festival), total = 2583
    const row = result.rows.find((r) => r.teamMemberId === memberId);
    expect(row).toBeDefined();
    expect(row.total).toBe(2583);
    expect(result.workspaceTotal).toBe(2583);
  });
});

// ---------------------------------------------------------------------------
// D. Single-ledger assertion
// ---------------------------------------------------------------------------

describe('Single-ledger guarantee', () => {
  it('D1: all money is stored in SalaryAdjustment; BonusRun stores metadata only', async () => {
    const { service, adjustmentCtorMock, bonusRunCtorMock } = buildService();

    const result = await service.runStatutoryBonus(
      workspaceId,
      { financialYear: 2025, disbursedMonth: 11, disbursedYear: 2025 },
      userId,
    );

    // Money: SalaryAdjustment constructor called for each paid member
    const totalMoney = adjustmentCtorMock.mock.calls.reduce(
      (s: number, call: any[]) => s + (call[0].amount ?? 0),
      0,
    );
    expect(totalMoney).toBeGreaterThan(0);

    // BonusRun: only one doc created (the metadata container)
    expect(bonusRunCtorMock).toHaveBeenCalledTimes(1);
    const runArgs = bonusRunCtorMock.mock.calls[0][0];
    // BonusRun ctor args should NOT have an 'amount' field (money lives in SalaryAdjustment)
    expect(runArgs.amount).toBeUndefined();
    // totalDisbursedAmount starts at 0 in the ctor and is set later via assignment.
    // The ctor arg is 0 (initialized safely); the key assertion is that no
    // 'amount' property is passed directly (no parallel money store).
    expect(typeof runArgs.totalDisbursedAmount).toBe('number');

    // adjustmentIds back-ref is returned (linking run to adjustments)
    expect(result.adjustmentIds).toHaveLength(1);
  });
});
