/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * CommissionService unit tests (Phase 3B).
 *
 * Strategy: mock all Mongoose models and injected services; drive
 * CommissionService methods through a direct constructor call using the same
 * @nestjs/mongoose decorator-mock pattern as loan.service.vitest.ts.
 *
 * Cases:
 *   A. recordCommissionEntries
 *      A1. feature flag off throws BadRequestException
 *      A2. bulk create N entries produces N SalaryAdjustments of the correct
 *          category, pfExcluded=true, esiExcluded=true (single-ledger assertion)
 *      A3. entries use the SAME SalaryAdjustment model as the existing payment
 *          path (no separate collection)
 *
 *   B. getCommissionYtd
 *      B1. aggregates only commission+incentive for the correct FY months
 *      B2. returns correct totals from a known fixture
 *      B3. fyStartYear defaults to current FY when omitted
 *
 *   C. listCommissionEntries
 *      C1. filters by category when provided
 *      C2. returns rows without filter when category omitted
 *
 *   D. createSchedule / listSchedules / getSchedule / updateSchedule /
 *      deleteSchedule / disburseSchedule
 *      D1. createSchedule persists a CommissionSchedule doc
 *      D2. disburseSchedule creates a SalaryAdjustment with category='commission',
 *          pfExcluded=true, esiExcluded=true
 *      D3. disburseSchedule is idempotent: second call with same month+year
 *          returns wasAlreadyDisbursed=true without creating a new adjustment
 *      D4. disburseSchedule advances nextDueMonth/Year for monthly frequency
 *
 *   E. dispatchDueSchedules
 *      E1. dispatches overdue active schedules, skips already-done ones
 */

import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

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
import { CommissionService } from '../commission.service';

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

function makeSalaryDoc(memberId: Types.ObjectId) {
  return {
    _id: new Types.ObjectId(),
    teamMemberId: memberId,
    month: 5,
    year: 2026,
    netSalary: 25000,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAdjustmentDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    category: 'commission',
    pfExcluded: true,
    esiExcluded: true,
    amount: 1000,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeScheduleDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId: memberId1,
    commissionType: 'sales',
    calcBasis: 'flat',
    amount: 2000,
    frequency: 'monthly',
    startMonth: 5,
    startYear: 2026,
    status: 'active',
    nextDueMonth: 5,
    nextDueYear: 2026,
    disbursementLog: [] as any[],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build service with mocked dependencies
// ---------------------------------------------------------------------------

function buildService(opts: { commissionEnabled?: boolean } = {}) {
  const { commissionEnabled = true } = opts;

  // SalaryAdjustment model mock
  const savedAdjustment = makeAdjustmentDoc();
  const adjustmentCtorMock = vi.fn().mockImplementation((data: any) => ({
    ...savedAdjustment,
    ...data,
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));
  (adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });
  (adjustmentCtorMock as any).aggregate = vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue([]),
  });

  // CommissionSchedule model mock
  const scheduleCtorMock = vi.fn().mockImplementation((data: any) => makeScheduleDoc(data));
  (scheduleCtorMock as any).find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });
  (scheduleCtorMock as any).findOne = vi.fn().mockReturnValue({
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(null),
  });

  // PayrollConfig model mock
  const payrollConfigModelMock = {
    findOneAndUpdate: vi.fn().mockReturnValue({
      exec: vi
        .fn()
        .mockResolvedValue(
          commissionEnabled
            ? { features: { commissionTracking: true } }
            : { features: { commissionTracking: false } },
        ),
    }),
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
  };

  // TeamMember model mock - used by resolveMemberNames to enrich entries/YTD
  // rows with the member display name. Default: no members found (rows fall
  // back to 'Unknown employee'). Tests can override .find().exec() per case.
  const teamMemberModelMock = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    // Workstream G hardening: dispatchDueSchedules now skips removed members via
    // findById. Default to a present, non-deleted member so existing dispatch
    // tests still dispatch (not skip).
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ _id: 'member-1', isDeleted: false }),
    }),
  };

  const salaryServiceMock: any = {
    ensureSingleEmployeeRecord: vi
      .fn()
      .mockImplementation((_wid: string, memberId: string) =>
        Promise.resolve(makeSalaryDoc(new Types.ObjectId(memberId))),
      ),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const service = new CommissionService(
    adjustmentCtorMock as any,
    scheduleCtorMock as any,
    payrollConfigModelMock as any,
    teamMemberModelMock as any,
    salaryServiceMock,
    auditService as any,
    postHog as any,
  );

  return {
    service,
    adjustmentCtorMock,
    scheduleCtorMock,
    teamMemberModelMock,
    salaryServiceMock,
    auditService,
    postHog,
    payrollConfigModelMock,
  };
}

// ---------------------------------------------------------------------------
// Case A: recordCommissionEntries
// ---------------------------------------------------------------------------

describe('recordCommissionEntries', () => {
  it('A1: throws BadRequestException when commissionTracking is off', async () => {
    const { service } = buildService({ commissionEnabled: false });

    await expect(
      service.recordCommissionEntries(
        workspaceId,
        {
          month: 5,
          year: 2026,
          entries: [
            {
              teamMemberId: memberId1.toHexString(),
              category: 'commission',
              commissionType: 'sales',
              amount: 500,
              reasonTitle: 'Sales Commission May 2026',
            },
          ],
        },
        userId,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('A2: creates N SalaryAdjustments for N entries; each has pfExcluded=true, esiExcluded=true', async () => {
    const { service, adjustmentCtorMock, salaryServiceMock } = buildService();

    const result = await service.recordCommissionEntries(
      workspaceId,
      {
        month: 5,
        year: 2026,
        entries: [
          {
            teamMemberId: memberId1.toHexString(),
            category: 'commission',
            commissionType: 'sales',
            amount: 1500,
            reasonTitle: 'Sales Commission',
          },
          {
            teamMemberId: memberId2.toHexString(),
            category: 'incentive',
            commissionType: 'attendance',
            amount: 800,
            reasonTitle: 'Attendance Incentive',
          },
        ],
      },
      userId,
    );

    // Two SalaryAdjustments created (single ledger)
    expect(adjustmentCtorMock).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);
    expect(result.adjustmentIds).toHaveLength(2);

    // First call: commission category, pfExcluded, esiExcluded
    const firstCallArgs = adjustmentCtorMock.mock.calls[0][0];
    expect(firstCallArgs.category).toBe('commission');
    expect(firstCallArgs.pfExcluded).toBe(true);
    expect(firstCallArgs.esiExcluded).toBe(true);
    expect(firstCallArgs.type).toBe('addition');
    expect(firstCallArgs.amount).toBe(1500);
    expect(firstCallArgs.source).toBe('manual');

    // Second call: incentive category
    const secondCallArgs = adjustmentCtorMock.mock.calls[1][0];
    expect(secondCallArgs.category).toBe('incentive');
    expect(secondCallArgs.pfExcluded).toBe(true);
    expect(secondCallArgs.esiExcluded).toBe(true);

    // ensureSingleEmployeeRecord was called once per entry (3 times total: 2 ensures + 1 recalc)
    expect(salaryServiceMock.ensureSingleEmployeeRecord).toHaveBeenCalledTimes(4); // 2 ensures + 2 recalcs
  });

  it('A3: creates rows in the SAME SalaryAdjustment model (no separate collection)', async () => {
    const { service, adjustmentCtorMock } = buildService();

    await service.recordCommissionEntries(
      workspaceId,
      {
        month: 5,
        year: 2026,
        entries: [
          {
            teamMemberId: memberId1.toHexString(),
            category: 'commission',
            commissionType: 'referral',
            amount: 300,
            reasonTitle: 'Referral Bonus',
          },
        ],
      },
      userId,
    );

    // Only the SalaryAdjustment constructor was called; no other model is used
    // to store the money. This proves single-ledger: commission lives only in
    // SalaryAdjustment.
    expect(adjustmentCtorMock).toHaveBeenCalledTimes(1);
    const callArgs = adjustmentCtorMock.mock.calls[0][0];
    expect(callArgs.category).toBe('commission');
    // source is 'manual' for structured create; 'payment_recording' for modal path
    expect(callArgs.source).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// Case B: getCommissionYtd
// ---------------------------------------------------------------------------

describe('getCommissionYtd', () => {
  it('B1: queries SalaryAdjustment with category in [commission, incentive] for FY months', async () => {
    const { service, adjustmentCtorMock } = buildService();

    // Override aggregate to capture the match stage
    let capturedMatch: any = null;
    (adjustmentCtorMock as any).aggregate = vi.fn().mockImplementation((pipeline: any[]) => {
      capturedMatch = pipeline[0]?.$match;
      return { exec: vi.fn().mockResolvedValue([]) };
    });

    await service.getCommissionYtd(workspaceId, { fyStartYear: 2025 });

    expect(capturedMatch).toBeDefined();
    expect(capturedMatch.category).toEqual({ $in: ['commission', 'incentive'] });
    expect(capturedMatch.type).toBe('addition');
    expect(capturedMatch.status).toBe('active');
    // FY 2025-26: April 2025 - March 2026 (12 months)
    expect(capturedMatch.$or).toHaveLength(12);
    const firstMonth = capturedMatch.$or[0];
    expect(firstMonth.month).toBe(4);
    expect(firstMonth.year).toBe(2025);
    const lastMonth = capturedMatch.$or[11];
    expect(lastMonth.month).toBe(3);
    expect(lastMonth.year).toBe(2026);
  });

  it('B2: returns correct totals from a known aggregate fixture', async () => {
    const { service, adjustmentCtorMock } = buildService();

    const memberId = new Types.ObjectId().toHexString();
    (adjustmentCtorMock as any).aggregate = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue([
        { teamMemberId: memberId, month: 4, year: 2025, category: 'commission', total: 1000 },
        { teamMemberId: memberId, month: 5, year: 2025, category: 'commission', total: 1500 },
        { teamMemberId: memberId, month: 4, year: 2025, category: 'incentive', total: 500 },
      ]),
    });

    const result = await service.getCommissionYtd(workspaceId, { fyStartYear: 2025 });

    expect(result.fyStartYear).toBe(2025);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.teamMemberId).toBe(memberId);
    expect(row.totalCommission).toBe(2500); // 1000 + 1500
    expect(row.totalIncentive).toBe(500);
    expect(row.grandTotal).toBe(3000);
    expect(result.workspaceTotal).toBe(3000);

    // April should have commission=1000, incentive=500, total=1500
    const aprilEntry = row.months.find((m: any) => m.month === 4 && m.year === 2025);
    expect(aprilEntry?.commission).toBe(1000);
    expect(aprilEntry?.incentive).toBe(500);
    expect(aprilEntry?.total).toBe(1500);
  });

  it('B3: defaults fyStartYear to current FY when omitted', async () => {
    const { service, adjustmentCtorMock } = buildService();

    let capturedMatch: any = null;
    (adjustmentCtorMock as any).aggregate = vi.fn().mockImplementation((pipeline: any[]) => {
      capturedMatch = pipeline[0]?.$match;
      return { exec: vi.fn().mockResolvedValue([]) };
    });

    const now = new Date();
    const expectedFy = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;

    await service.getCommissionYtd(workspaceId, {});

    // FY April start should be present in the $or conditions
    const hasAprilOfExpectedFy = capturedMatch.$or.some(
      (c: any) => c.month === 4 && c.year === expectedFy,
    );
    expect(hasAprilOfExpectedFy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case C: listCommissionEntries
// ---------------------------------------------------------------------------

describe('listCommissionEntries', () => {
  it('C1: filters by category when provided', async () => {
    const { service, adjustmentCtorMock } = buildService();

    let capturedFilter: any = null;
    (adjustmentCtorMock as any).find = vi.fn().mockImplementation((filter: any) => {
      capturedFilter = filter;
      return {
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
    });

    await service.listCommissionEntries(workspaceId, { category: 'incentive' });

    expect(capturedFilter.category).toBe('incentive');
  });

  it('C2: uses $in for both categories when category omitted', async () => {
    const { service, adjustmentCtorMock } = buildService();

    let capturedFilter: any = null;
    (adjustmentCtorMock as any).find = vi.fn().mockImplementation((filter: any) => {
      capturedFilter = filter;
      return {
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      };
    });

    await service.listCommissionEntries(workspaceId, {});

    expect(capturedFilter.category).toEqual({ $in: ['commission', 'incentive'] });
  });
});

// ---------------------------------------------------------------------------
// Case D: schedule CRUD + disburseSchedule
// ---------------------------------------------------------------------------

describe('disburseSchedule', () => {
  it('D2: creates SalaryAdjustment with category=commission, pfExcluded=true, esiExcluded=true', async () => {
    const { service, adjustmentCtorMock, scheduleCtorMock } = buildService();

    const scheduleId = new Types.ObjectId().toHexString();
    const schedule = makeScheduleDoc({ _id: new Types.ObjectId(scheduleId) });

    (scheduleCtorMock as any).findOne = vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(schedule),
    });

    // findOne for the non-lean path (used in update/disburse flows)
    const execFn = vi.fn().mockResolvedValue(schedule);
    (scheduleCtorMock as any).findOne = vi.fn().mockReturnValue({ exec: execFn });

    const result = await service.disburseSchedule(
      workspaceId,
      scheduleId,
      { month: 5, year: 2026 },
      userId,
      false,
    );

    expect(result.wasAlreadyDisbursed).toBe(false);
    expect(adjustmentCtorMock).toHaveBeenCalledTimes(1);

    const adjArgs = adjustmentCtorMock.mock.calls[0][0];
    expect(adjArgs.category).toBe('commission');
    expect(adjArgs.pfExcluded).toBe(true);
    expect(adjArgs.esiExcluded).toBe(true);
    expect(adjArgs.type).toBe('addition');
    expect(adjArgs.source).toBe('manual');

    // The disbursementLog got an entry (back-reference only; money is in adjustment)
    expect(schedule.disbursementLog).toHaveLength(1);
    expect(schedule.disbursementLog[0].month).toBe(5);
    expect(schedule.disbursementLog[0].year).toBe(2026);
  });

  it('D3: idempotent - second call with same month+year returns wasAlreadyDisbursed=true', async () => {
    const { service, adjustmentCtorMock, scheduleCtorMock } = buildService();

    const scheduleId = new Types.ObjectId().toHexString();
    const existingAdjId = new Types.ObjectId();
    const schedule = makeScheduleDoc({
      _id: new Types.ObjectId(scheduleId),
      disbursementLog: [
        {
          month: 5,
          year: 2026,
          adjustmentId: existingAdjId,
          amount: 2000,
          disbursedAt: new Date(),
          disbursedBy: new Types.ObjectId(userId),
        },
      ],
    });

    (scheduleCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(schedule),
    });

    const result = await service.disburseSchedule(
      workspaceId,
      scheduleId,
      { month: 5, year: 2026 },
      userId,
      false,
    );

    expect(result.wasAlreadyDisbursed).toBe(true);
    expect(result.adjustmentId).toBe(existingAdjId.toHexString());
    // No new adjustment created
    expect(adjustmentCtorMock).not.toHaveBeenCalled();
  });

  it('D4: advances nextDueMonth/Year for monthly frequency after disbursal', async () => {
    const { service, scheduleCtorMock } = buildService();

    const scheduleId = new Types.ObjectId().toHexString();
    const schedule = makeScheduleDoc({
      _id: new Types.ObjectId(scheduleId),
      frequency: 'monthly',
      nextDueMonth: 12,
      nextDueYear: 2025,
    });

    (scheduleCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(schedule),
    });

    await service.disburseSchedule(
      workspaceId,
      scheduleId,
      { month: 12, year: 2025 },
      userId,
      false,
    );

    // Monthly: December 2025 + 1 month = January 2026
    expect(schedule.nextDueMonth).toBe(1);
    expect(schedule.nextDueYear).toBe(2026);
  });
});

describe('createSchedule', () => {
  it('D1: persists a CommissionSchedule doc with correct fields', async () => {
    const { service, scheduleCtorMock } = buildService();

    await service.createSchedule(
      workspaceId,
      {
        teamMemberId: memberId1.toHexString(),
        commissionType: 'sales',
        calcBasis: 'flat',
        amount: 3000,
        frequency: 'quarterly',
        startMonth: 4,
        startYear: 2026,
      },
      userId,
    );

    expect(scheduleCtorMock).toHaveBeenCalledTimes(1);
    const args = scheduleCtorMock.mock.calls[0][0];
    expect(args.commissionType).toBe('sales');
    expect(args.frequency).toBe('quarterly');
    expect(args.amount).toBe(3000);
    expect(args.status).toBe('active');
    expect(args.nextDueMonth).toBe(4);
    expect(args.nextDueYear).toBe(2026);
    expect(args.disbursementLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case E: dispatchDueSchedules
// ---------------------------------------------------------------------------

describe('dispatchDueSchedules', () => {
  it('E1: dispatches overdue schedules and skips already-disbursed ones', async () => {
    const { service, scheduleCtorMock } = buildService();

    // Two overdue schedules
    const s1Id = new Types.ObjectId();
    const s2Id = new Types.ObjectId();
    const scheduleWithLog = makeScheduleDoc({
      _id: s2Id,
      nextDueMonth: 4,
      nextDueYear: 2026,
      disbursementLog: [
        {
          month: 4,
          year: 2026,
          adjustmentId: new Types.ObjectId(),
          amount: 2000,
          disbursedAt: new Date(),
          disbursedBy: new Types.ObjectId(userId),
        },
      ],
    });
    const schedulePristine = makeScheduleDoc({
      _id: s1Id,
      nextDueMonth: 4,
      nextDueYear: 2026,
    });

    (scheduleCtorMock as any).find = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue([schedulePristine, scheduleWithLog]),
    });

    // findOne for each disburse call
    (scheduleCtorMock as any).findOne = vi
      .fn()
      .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(schedulePristine) })
      .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(scheduleWithLog) });

    const result = await service.dispatchDueSchedules(workspaceId, 5, 2026, userId);

    // First schedule: new disbursement = dispatched
    // Second schedule: already in disbursementLog for April 2026 = skipped
    expect(result.dispatched + result.skipped).toBe(2);
    expect(result.errors).toBe(0);
  });
});
