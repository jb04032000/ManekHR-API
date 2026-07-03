/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * LoanService unit tests (Slice 2).
 *
 * Strategy: drive createLoan and previewLoanSchedule by constructing
 * LoanService with mocked dependencies. We stub the SalaryService private
 * methods accessed via bracket notation (teamModel, ensureSalaryRecord,
 * recalculateSalaryFromAdjustments, getPayrollConfig) because LoanService
 * delegates to SalaryService for salary-record lookups and payroll config.
 *
 * The compliance guard is the real ComplianceGuardService (pure functions).
 *
 * Cases:
 *   A. previewLoanSchedule - zero/flat/reducing returns correct shape.
 *   B. createLoan - no approval chain: status=active, deductions created.
 *   C. createLoan - with approval chain: status=pending_approval, no deductions.
 *   D. createLoan - feature flag off: throws BadRequestException.
 *
 * The @nestjs/mongoose decorator mock must precede the LoanService import so
 * the schema @Prop/@Schema decorators are no-ops (same pattern as
 * salary.service.advance-plan.vitest.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceGuardService } from '../compliance-guard.service';

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
import { LoanService } from '../loan.service';

// ---------------------------------------------------------------------------
// Shared test IDs
// ---------------------------------------------------------------------------

const workspaceId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();
const userId = new Types.ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoanDoc(extra: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    installments: [] as any[],
    linkedAdjustmentIds: [] as any[],
    recoveredAmount: 0,
    remainingAmount: 0,
    status: 'active',
    save: vi.fn().mockResolvedValue(undefined),
    ...extra,
  };
}

function makeSalaryRecord(netSalary: number) {
  return {
    _id: new Types.ObjectId(),
    baseSalary: Math.max(netSalary, 30000),
    additions: 0,
    deductions: 0,
    netSalary,
    isLocked: false,
    month: 6,
    year: 2026,
    teamMemberId,
    workspaceId: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Build service with all dependencies mocked
// ---------------------------------------------------------------------------

function buildService(
  opts: {
    loanManagementEnabled?: boolean;
    hasApprovalChainDefault?: boolean;
  } = {},
) {
  const { loanManagementEnabled = true, hasApprovalChainDefault = false } = opts;

  const loanCtorMock = vi.fn().mockImplementation((data: any) => {
    return makeLoanDoc({
      ...data,
      installments: data.installments ?? [],
      linkedAdjustmentIds: data.linkedAdjustmentIds ?? [],
    });
  });
  // Chainable findOne for warnIfDuplicateLoanType (.select().lean().exec())
  (loanCtorMock as any).findOne = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(null),
  });
  (loanCtorMock as any).find = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });

  const adjustmentCtorMock = vi.fn().mockImplementation(() => ({
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));
  (adjustmentCtorMock as any).find = vi.fn().mockResolvedValue([]);
  (adjustmentCtorMock as any).findOne = vi.fn().mockResolvedValue(null);

  const payrollConfigModelMock = {
    findOneAndUpdate: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        features: { loanManagement: loanManagementEnabled },
        compliance: {
          minimumWageMonthly: null,
          deductionCapPercent: 100, // no cap interference in these tests
        },
        loanConfig: {
          sbiBenchmarkRate: 8.65,
          perquisiteExemptionThreshold: 200000,
          maxActiveLoanAmount: 0,
          maxActiveLoanCount: 0,
          approvalChainDefault: hasApprovalChainDefault
            ? [{ approverId: new Types.ObjectId(), approverName: 'HR Manager' }]
            : [],
        },
      }),
    }),
  };

  // SalaryService mock - expose the properties LoanService accesses
  const teamModelMock = {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 30000,
        minimumWageMonthlyOverride: null,
      }),
    }),
  };

  const ensureSalaryRecordMock = vi.fn().mockResolvedValue(makeSalaryRecord(20000));
  const recalculateMock = vi.fn().mockResolvedValue(makeSalaryRecord(20000));

  const salaryServiceMock: any = {
    teamModel: teamModelMock,
    ensureSalaryRecord: ensureSalaryRecordMock,
    recalculateSalaryFromAdjustments: recalculateMock,
    getPayrollConfig: vi.fn().mockResolvedValue({
      features: { loanManagement: loanManagementEnabled },
      compliance: {
        minimumWageMonthly: null,
        deductionCapPercent: 100,
      },
      loanConfig: {
        sbiBenchmarkRate: 8.65,
        perquisiteExemptionThreshold: 200000,
        maxActiveLoanAmount: 0,
        maxActiveLoanCount: 0,
        approvalChainDefault: hasApprovalChainDefault
          ? [{ approverId: new Types.ObjectId(), approverName: 'HR Manager' }]
          : [],
      },
    }),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const service = new LoanService(
    loanCtorMock as any, // loanModel
    adjustmentCtorMock as any, // salaryAdjustmentModel
    payrollConfigModelMock as any, // payrollConfigModel

    salaryServiceMock, // salaryService
    auditService as any, // auditService
    postHog as any, // postHog
    new ComplianceGuardService(), // complianceGuard (real - pure functions)
  );

  return {
    service,
    loanCtorMock,
    adjustmentCtorMock,
    salaryServiceMock,
    ensureSalaryRecordMock,
    auditService,
    postHog,
  };
}

// ---------------------------------------------------------------------------
// Case A: previewLoanSchedule
// ---------------------------------------------------------------------------

describe('previewLoanSchedule', () => {
  it('zero-rate: returns correct schedule shape with no interest', () => {
    const { service } = buildService();
    const result = service.previewLoanSchedule(workspaceId, {
      loanType: 'personal',
      principalAmount: 60000,
      interestType: 'zero',
      annualInterestRate: 0,
      tenorMonths: 6,
      startMonth: 6,
      startYear: 2026,
    });
    expect(result.installments).toHaveLength(6);
    expect(result.totalInterest).toBe(0);
    expect(result.totalRepayable).toBe(60000);
    expect(result.emiAmount).toBe(10000);
    const principalSum = result.installments.reduce((s, r) => s + r.principalPart, 0);
    expect(Math.round(principalSum * 100) / 100).toBe(60000);
  });

  it('flat-rate: total interest computed correctly', () => {
    const { service } = buildService();
    // P=120000, rate=12%, tenor=12 -> totalInterest=14400
    const result = service.previewLoanSchedule(workspaceId, {
      loanType: 'personal',
      principalAmount: 120000,
      interestType: 'flat',
      annualInterestRate: 12,
      tenorMonths: 12,
      startMonth: 4,
      startYear: 2026,
    });
    expect(result.totalInterest).toBe(14400);
    expect(result.totalRepayable).toBe(134400);
    const principalSum = result.installments.reduce((s, r) => s + r.principalPart, 0);
    expect(Math.round(principalSum * 100) / 100).toBe(120000);
  });

  it('reducing_balance: sum(principalPart) === principal exactly', () => {
    const { service } = buildService();
    const result = service.previewLoanSchedule(workspaceId, {
      loanType: 'personal',
      principalAmount: 100000,
      interestType: 'reducing_balance',
      annualInterestRate: 12,
      tenorMonths: 12,
      startMonth: 1,
      startYear: 2026,
    });
    const principalSum = result.installments.reduce((s, r) => s + r.principalPart, 0);
    expect(Math.round(principalSum * 100) / 100).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// Case B: createLoan - no approval chain (active + deductions created)
// ---------------------------------------------------------------------------

describe('createLoan - no approval chain', () => {
  let ctx: ReturnType<typeof buildService>;

  beforeEach(() => {
    ctx = buildService({ loanManagementEnabled: true, hasApprovalChainDefault: false });
  });

  it('creates the loan with status=active when no approval chain', async () => {
    const svc = ctx.service;
    const loan = await svc.createLoan(
      workspaceId,
      {
        teamMemberId: String(teamMemberId),
        loanType: 'personal',
        principalAmount: 60000,
        disbursementDate: '2026-06-01',
        interestType: 'zero',
        annualInterestRate: 0,
        tenorMonths: 6,
        startMonth: 6,
        startYear: 2026,
      },
      userId,
    );

    expect(loan.status).toBe('active');
    expect(ctx.loanCtorMock).toHaveBeenCalledOnce();
  });

  it('creates loan_recovery SalaryAdjustments for each installment', async () => {
    const svc = ctx.service;
    await svc.createLoan(
      workspaceId,
      {
        teamMemberId: String(teamMemberId),
        loanType: 'personal',
        principalAmount: 60000,
        disbursementDate: '2026-06-01',
        interestType: 'zero',
        annualInterestRate: 0,
        tenorMonths: 6,
        startMonth: 6,
        startYear: 2026,
      },
      userId,
    );

    // One adjustment per installment (6 installments, all net=20000 which covers 10000 EMI)
    expect(ctx.adjustmentCtorMock).toHaveBeenCalledTimes(6);

    // Each adjustment should have category loan_recovery
    const firstCall = ctx.adjustmentCtorMock.mock.calls[0][0];
    expect(firstCall.category).toBe('loan_recovery');
    expect(firstCall.type).toBe('deduction');
    expect(firstCall.source).toBe('system');
  });

  it('emits PostHog event salary.loan_created', async () => {
    await ctx.service.createLoan(
      workspaceId,
      {
        teamMemberId: String(teamMemberId),
        loanType: 'personal',
        principalAmount: 60000,
        disbursementDate: '2026-06-01',
        interestType: 'zero',
        annualInterestRate: 0,
        tenorMonths: 6,
        startMonth: 6,
        startYear: 2026,
      },
      userId,
    );

    expect(ctx.postHog.capture).toHaveBeenCalledOnce();
    const captureArgs = ctx.postHog.capture.mock.calls[0][0];
    expect(captureArgs.event).toBe('salary.loan_created');
    expect(captureArgs.properties.status).toBe('active');
  });

  it('fires audit logEvent once', async () => {
    await ctx.service.createLoan(
      workspaceId,
      {
        teamMemberId: String(teamMemberId),
        loanType: 'personal',
        principalAmount: 60000,
        disbursementDate: '2026-06-01',
        interestType: 'zero',
        annualInterestRate: 0,
        tenorMonths: 6,
        startMonth: 6,
        startYear: 2026,
      },
      userId,
    );

    // One audit event for loan creation (separate from adjustment events)
    const loanCreatedEvents = ctx.auditService.logEvent.mock.calls.filter(
      (c: any) => c[0].action === 'salary.loan.created',
    );
    expect(loanCreatedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Case C: createLoan - with approval chain (pending_approval, no deductions)
// ---------------------------------------------------------------------------

describe('createLoan - with approval chain (workspace default)', () => {
  let ctx: ReturnType<typeof buildService>;

  beforeEach(() => {
    ctx = buildService({ loanManagementEnabled: true, hasApprovalChainDefault: true });
  });

  it('creates loan with status=pending_approval', async () => {
    const loan = await ctx.service.createLoan(
      workspaceId,
      {
        teamMemberId: String(teamMemberId),
        loanType: 'personal',
        principalAmount: 60000,
        disbursementDate: '2026-06-01',
        interestType: 'zero',
        annualInterestRate: 0,
        tenorMonths: 6,
        startMonth: 6,
        startYear: 2026,
      },
      userId,
    );

    expect(loan.status).toBe('pending_approval');
  });

  it('does NOT create SalaryAdjustments when pending_approval', async () => {
    await ctx.service.createLoan(
      workspaceId,
      {
        teamMemberId: String(teamMemberId),
        loanType: 'personal',
        principalAmount: 60000,
        disbursementDate: '2026-06-01',
        interestType: 'zero',
        annualInterestRate: 0,
        tenorMonths: 6,
        startMonth: 6,
        startYear: 2026,
      },
      userId,
    );

    // No deduction adjustments should be created until approval
    expect(ctx.adjustmentCtorMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case D: feature flag disabled
// ---------------------------------------------------------------------------

describe('createLoan - feature disabled', () => {
  it('throws BadRequestException when loanManagement is disabled', async () => {
    const { service } = buildService({ loanManagementEnabled: false });

    await expect(
      service.createLoan(
        workspaceId,
        {
          teamMemberId: String(teamMemberId),
          loanType: 'personal',
          principalAmount: 60000,
          disbursementDate: '2026-06-01',
          interestType: 'zero',
          annualInterestRate: 0,
          tenorMonths: 6,
          startMonth: 6,
          startYear: 2026,
        },
        userId,
      ),
    ).rejects.toThrow('Loan Management is not enabled');
  });
});
