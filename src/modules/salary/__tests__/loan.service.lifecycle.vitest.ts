/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * LoanService lifecycle tests (Slice 3).
 *
 * Strategy: mock all I/O dependencies (loanModel, salaryAdjustmentModel,
 * salaryService private methods) and test the pure business logic of each
 * lifecycle method. The ComplianceGuardService is the real (pure) implementation.
 *
 * Cases:
 *   A. approveLoan - intermediate step: status stays pending_approval, no deductions.
 *   B. approveLoan - final approver: transitions to active, materializes deductions.
 *   C. approveLoan - reject: transitions to reversed, no deductions.
 *   D. approveLoan - illegal state (not pending_approval): throws.
 *   E. skipInstallment - extend_tenor: adds one installment, tenorMonths++.
 *   F. skipInstallment - raise_emi: future installment EMIs are raised.
 *   G. skipInstallment - already applied: throws.
 *   H. skipInstallment - on non-active loan: throws.
 *   I. pauseResumeLoan - pause: status=paused, future adjustments reversed.
 *   J. pauseResumeLoan - resume: status=active, materializeLoanInstallments called.
 *   K. pauseResumeLoan - pause already-paused: throws.
 *   L. pauseResumeLoan - resume non-paused: throws.
 *   M. earlyPayoffLoan - full payoff: status=completed, future deductions reversed.
 *   N. earlyPayoffLoan - partial payoff: remainingAmount reduced, re-materializes.
 *   O. earlyPayoffLoan - illegal state (completed): throws.
 *   P. topUpLoan - active loan: new loan created, old closed as top_up_superseded.
 *   Q. topUpLoan - paused loan: throws.
 *   R. writeOffLoan - active loan: status=written_off, future adjustments reversed.
 *   S. writeOffLoan - illegal state (completed): throws.
 *
 * Skip knock-on math is also verified against direct schedule recomputation
 * in the lower-level helpers so the service-level tests focus on state transitions.
 * The pure math is already covered by loan-schedule.util.vitest.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
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

import { LoanService } from '../loan.service';

// ---------------------------------------------------------------------------
// Shared test IDs
// ---------------------------------------------------------------------------

const workspaceId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();
const userId = new Types.ObjectId().toHexString();
const _approverId1 = new Types.ObjectId().toHexString();
const approverId2 = new Types.ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstallment(
  overrides: Partial<{
    index: number;
    month: number;
    year: number;
    principalPlanned: number;
    interestPlanned: number;
    emiPlanned: number;
    appliedAmount: number;
    status: string;
    adjustmentId: Types.ObjectId;
  }> = {},
) {
  return {
    index: 1,
    month: 7,
    year: 2026,
    principalPlanned: 10000,
    interestPlanned: 0,
    emiPlanned: 10000,
    appliedAmount: 0,
    status: 'scheduled',
    adjustmentId: undefined,
    ...overrides,
  };
}

function makeLoanDoc(overrides: Record<string, any> = {}) {
  const doc = {
    _id: new Types.ObjectId(),
    workspaceId: toObjectId(workspaceId),
    teamMemberId,
    loanType: 'personal',
    principalAmount: 60000,
    interestType: 'zero',
    annualInterestRate: 0,
    tenorMonths: 6,
    emiAmount: 10000,
    startMonth: 7,
    startYear: 2026,
    status: 'active',
    recoveredAmount: 0,
    remainingPrincipal: 60000,
    remainingAmount: 60000,
    totalInterestScheduled: 0,
    interestPaidToDate: 0,
    installments: [] as any[],
    linkedAdjustmentIds: [] as any[],
    approvalChain: [] as any[],
    medicalLoanExempt: false,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return doc;
}

function makeAdjustmentDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    status: 'active',
    month: 7,
    year: 2026,
    amount: 10000,
    workspaceId: toObjectId(workspaceId),
    teamMemberId,
    salaryId: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

function makeSalaryRecord(netSalary = 30000) {
  return {
    _id: new Types.ObjectId(),
    baseSalary: 30000,
    additions: 0,
    deductions: 0,
    netSalary,
    isLocked: false,
    month: 7,
    year: 2026,
    teamMemberId,
    workspaceId: toObjectId(workspaceId),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Build service with all dependencies mocked
// ---------------------------------------------------------------------------

function buildService(
  opts: {
    loanDoc?: Record<string, any>;
    adjustmentDocs?: Record<string, any>[];
    loanManagementEnabled?: boolean;
  } = {},
) {
  const { loanDoc, adjustmentDocs = [], loanManagementEnabled = true } = opts;

  const savedLoanDoc = loanDoc ? makeLoanDoc(loanDoc) : makeLoanDoc();

  // loanModel: findOne returns savedLoanDoc; constructor creates new doc
  const newLoanDoc = makeLoanDoc({
    status: 'active',
    installments: [],
    linkedAdjustmentIds: [],
  });
  const loanCtorMock = vi.fn().mockImplementation(() => newLoanDoc);
  (loanCtorMock as any).findOne = vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue(savedLoanDoc),
  });
  (loanCtorMock as any).find = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });

  // salaryAdjustmentModel: constructor + findById
  const adjustmentCtorMock = vi.fn().mockImplementation(() => ({
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));
  (adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  });
  // findById returns adjustment docs in order from the adjustmentDocs list
  let adjCallIdx = 0;
  (adjustmentCtorMock as any).findById = vi.fn().mockImplementation(() => {
    const doc = adjustmentDocs[adjCallIdx] ?? makeAdjustmentDoc();
    adjCallIdx = (adjCallIdx + 1) % Math.max(adjustmentDocs.length, 1);
    return { exec: vi.fn().mockResolvedValue(doc) };
  });

  const payrollConfigModelMock = {};

  const salaryModelMock = {
    findById: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(makeSalaryRecord()),
    }),
  };

  const ensureSalaryRecordMock = vi.fn().mockResolvedValue(makeSalaryRecord());
  const recalculateMock = vi.fn().mockResolvedValue(makeSalaryRecord());

  const salaryServiceMock: any = {
    salaryModel: salaryModelMock,
    teamModel: {
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
    },
    ensureSalaryRecord: ensureSalaryRecordMock,
    recalculateSalaryFromAdjustments: recalculateMock,
    getPayrollConfig: vi.fn().mockResolvedValue({
      features: { loanManagement: loanManagementEnabled },
      compliance: { minimumWageMonthly: null, deductionCapPercent: 100 },
      loanConfig: {
        sbiBenchmarkRate: 8.65,
        approvalChainDefault: [],
      },
    }),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const service = new LoanService(
    loanCtorMock as any,
    adjustmentCtorMock as any,
    payrollConfigModelMock as any,
    salaryServiceMock,
    auditService as any,
    postHog as any,
    new ComplianceGuardService(),
  );

  return {
    service,
    savedLoanDoc,
    newLoanDoc,
    loanCtorMock,
    adjustmentCtorMock,
    salaryServiceMock,
    auditService,
    postHog,
  };
}

// ---------------------------------------------------------------------------
// Case A: approveLoan - intermediate step (two-step chain)
// ---------------------------------------------------------------------------

describe('approveLoan - intermediate step', () => {
  it('does NOT transition to active when a second pending step remains', async () => {
    const approvalChain = [
      { stepIndex: 0, approverId: toObjectId(userId), approverName: 'HR', status: 'pending' },
      {
        stepIndex: 1,
        approverId: toObjectId(approverId2),
        approverName: 'Manager',
        status: 'pending',
      },
    ];
    const { service, savedLoanDoc, auditService, adjustmentCtorMock } = buildService({
      loanDoc: {
        status: 'pending_approval',
        approvalChain,
      },
    });

    const result = await service.approveLoan(workspaceId, String(savedLoanDoc._id), userId, {
      decision: 'approve',
      comment: 'Looks good',
    });

    // Still pending_approval because step 1 is still pending.
    expect(result.status).toBe('pending_approval');
    // No deductions materialized.
    expect(adjustmentCtorMock).not.toHaveBeenCalled();
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'salary.loan.approval_step_approved' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Case B: approveLoan - final approver materializes deductions
// ---------------------------------------------------------------------------

describe('approveLoan - final approver', () => {
  it('transitions to active and materializes deductions when last step approves', async () => {
    const installments = [
      makeInstallment({ index: 1, month: 7, year: 2026 }),
      makeInstallment({ index: 2, month: 8, year: 2026 }),
    ];
    const approvalChain = [
      { stepIndex: 0, approverId: toObjectId(userId), approverName: 'HR', status: 'pending' },
    ];
    const { service, savedLoanDoc, adjustmentCtorMock } = buildService({
      loanDoc: {
        status: 'pending_approval',
        installments,
        approvalChain,
        principalAmount: 20000,
        remainingAmount: 20000,
        remainingPrincipal: 20000,
        totalInterestScheduled: 0,
      },
    });

    const result = await service.approveLoan(workspaceId, String(savedLoanDoc._id), userId, {
      decision: 'approve',
    });

    expect(result.status).toBe('active');
    // materializeLoanInstallments called -> adjustments created (one per installment).
    expect(adjustmentCtorMock).toHaveBeenCalledTimes(2);
  });

  it('emits PostHog event salary.loan_approved with isFinalApprover=true', async () => {
    const approvalChain = [
      { stepIndex: 0, approverId: toObjectId(userId), approverName: 'HR', status: 'pending' },
    ];
    const { service, savedLoanDoc, postHog } = buildService({
      loanDoc: {
        status: 'pending_approval',
        installments: [makeInstallment()],
        approvalChain,
        principalAmount: 10000,
        remainingAmount: 10000,
      },
    });

    await service.approveLoan(workspaceId, String(savedLoanDoc._id), userId, {
      decision: 'approve',
    });

    const captureCall = postHog.capture.mock.calls[0][0];
    expect(captureCall.event).toBe('salary.loan_approved');
    expect(captureCall.properties.isFinalApprover).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case C: approveLoan - reject -> reversed, no deductions
// ---------------------------------------------------------------------------

describe('approveLoan - reject', () => {
  it('transitions to reversed with closureType=reversed', async () => {
    const approvalChain = [
      { stepIndex: 0, approverId: toObjectId(userId), approverName: 'HR', status: 'pending' },
    ];
    const { service, savedLoanDoc, adjustmentCtorMock, auditService } = buildService({
      loanDoc: {
        status: 'pending_approval',
        installments: [makeInstallment()],
        approvalChain,
      },
    });

    const result = await service.approveLoan(workspaceId, String(savedLoanDoc._id), userId, {
      decision: 'reject',
      comment: 'Not approved',
    });

    expect(result.status).toBe('reversed');
    expect(result.closureType).toBe('reversed');
    expect(adjustmentCtorMock).not.toHaveBeenCalled();
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'salary.loan.rejected' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Case D: approveLoan - illegal state
// ---------------------------------------------------------------------------

describe('approveLoan - illegal state', () => {
  it('throws BadRequestException when loan is not pending_approval', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'active', approvalChain: [] },
    });

    await expect(
      service.approveLoan(workspaceId, String(savedLoanDoc._id), userId, {
        decision: 'approve',
      }),
    ).rejects.toThrow("Cannot approve/reject a loan with status 'active'");
  });

  it('throws BadRequestException when caller has no pending step', async () => {
    const otherId = new Types.ObjectId().toHexString();
    const approvalChain = [
      { stepIndex: 0, approverId: toObjectId(otherId), approverName: 'Other', status: 'pending' },
    ];
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'pending_approval', approvalChain },
    });

    await expect(
      service.approveLoan(workspaceId, String(savedLoanDoc._id), userId, {
        decision: 'approve',
      }),
    ).rejects.toThrow('do not have a pending approval step');
  });
});

// ---------------------------------------------------------------------------
// Case E: skipInstallment - extend_tenor
// ---------------------------------------------------------------------------

describe('skipInstallment - extend_tenor', () => {
  it('appends one installment and increments tenorMonths', async () => {
    // Two future installments; skip index=1 with extend_tenor.
    const installments = [
      makeInstallment({ index: 1, month: 7, year: 2026, status: 'scheduled' }),
      makeInstallment({ index: 2, month: 8, year: 2026, status: 'scheduled' }),
    ];
    const { service, savedLoanDoc } = buildService({
      loanDoc: {
        status: 'active',
        installments,
        principalAmount: 20000,
        remainingAmount: 20000,
        tenorMonths: 2,
      },
    });

    const result = await service.skipInstallment(workspaceId, String(savedLoanDoc._id), userId, {
      installmentIndex: 1,
      knockOnChoice: 'extend_tenor',
      skipReason: 'Employee on leave',
    });

    // One new installment appended -> length becomes 3.
    expect(result.installments).toHaveLength(3);
    // Skipped installment marked as skipped.
    const skipped = result.installments.find((inst: any) => inst.index === 1);
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.knockOnChoice).toBe('extend_tenor');
    // tenorMonths incremented.
    expect(result.tenorMonths).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Case F: skipInstallment - raise_emi
// ---------------------------------------------------------------------------

describe('skipInstallment - raise_emi', () => {
  it('raises future installment EMIs by the skipped amount spread evenly', async () => {
    // Three installments: skip index=1, raise_emi across index=2 and index=3.
    const installments = [
      makeInstallment({
        index: 1,
        month: 7,
        year: 2026,
        emiPlanned: 10000,
        principalPlanned: 10000,
      }),
      makeInstallment({
        index: 2,
        month: 8,
        year: 2026,
        emiPlanned: 10000,
        principalPlanned: 10000,
      }),
      makeInstallment({
        index: 3,
        month: 9,
        year: 2026,
        emiPlanned: 10000,
        principalPlanned: 10000,
      }),
    ];
    const { service, savedLoanDoc } = buildService({
      loanDoc: {
        status: 'active',
        installments,
        principalAmount: 30000,
        remainingAmount: 30000,
        tenorMonths: 3,
      },
    });

    const result = await service.skipInstallment(workspaceId, String(savedLoanDoc._id), userId, {
      installmentIndex: 1,
      knockOnChoice: 'raise_emi',
      skipReason: 'Testing',
    });

    // Still 3 installments (no new month added).
    expect(result.installments).toHaveLength(3);
    // Skipped installment: status=skipped.
    expect(result.installments[0].status).toBe('skipped');
    // Future installments: EMI raised by 5000 each (10000 / 2 remaining = 5000 each).
    expect(result.installments[1].emiPlanned).toBe(15000);
    expect(result.installments[2].emiPlanned).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Case G: skipInstallment - already applied throws
// ---------------------------------------------------------------------------

describe('skipInstallment - already applied', () => {
  it('throws BadRequestException when installment is already applied', async () => {
    const installments = [makeInstallment({ index: 1, month: 6, year: 2026, status: 'applied' })];
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'active', installments },
    });

    await expect(
      service.skipInstallment(workspaceId, String(savedLoanDoc._id), userId, {
        installmentIndex: 1,
        knockOnChoice: 'extend_tenor',
        skipReason: 'Test',
      }),
    ).rejects.toThrow('already been applied');
  });
});

// ---------------------------------------------------------------------------
// Case H: skipInstallment - non-active loan throws
// ---------------------------------------------------------------------------

describe('skipInstallment - non-active loan', () => {
  it('throws BadRequestException when loan is paused', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'paused', installments: [makeInstallment()] },
    });

    await expect(
      service.skipInstallment(workspaceId, String(savedLoanDoc._id), userId, {
        installmentIndex: 1,
        knockOnChoice: 'extend_tenor',
        skipReason: 'Test',
      }),
    ).rejects.toThrow("Cannot skip an installment on a loan with status 'paused'");
  });
});

// ---------------------------------------------------------------------------
// Case I: pauseResumeLoan - pause
// ---------------------------------------------------------------------------

describe('pauseResumeLoan - pause', () => {
  it('transitions loan to paused and reverses future adjustments', async () => {
    const adjId = new Types.ObjectId();
    const installments = [
      // month >= current month = future
      makeInstallment({ index: 1, month: 7, year: 2026, adjustmentId: adjId, status: 'scheduled' }),
      makeInstallment({ index: 2, month: 8, year: 2026, status: 'scheduled' }),
    ];
    const adjDoc = makeAdjustmentDoc({ _id: adjId });
    const { service, savedLoanDoc, auditService } = buildService({
      loanDoc: { status: 'active', installments },
      adjustmentDocs: [adjDoc],
    });

    const result = await service.pauseResumeLoan(workspaceId, String(savedLoanDoc._id), userId, {
      action: 'pause',
      reason: 'Budget freeze',
    });

    expect(result.status).toBe('paused');
    expect(result.pausedBy).toBeDefined();
    // Future installments should be reversed (status mutation on the doc).
    expect(result.installments[0].status).toBe('reversed');
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'salary.loan.paused' }),
    );
  });

  it('stores pauseResumeDate when provided', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'active', installments: [] },
    });

    const result = await service.pauseResumeLoan(workspaceId, String(savedLoanDoc._id), userId, {
      action: 'pause',
      pauseResumeDate: '2026-09-01',
    });

    expect(result.pauseResumeDate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Case J: pauseResumeLoan - resume
// ---------------------------------------------------------------------------

describe('pauseResumeLoan - resume', () => {
  it('transitions loan to active and calls materializeLoanInstallments', async () => {
    // A paused loan with one reversed future installment.
    const installments = [makeInstallment({ index: 1, month: 7, year: 2026, status: 'reversed' })];
    const { service, savedLoanDoc, adjustmentCtorMock, auditService } = buildService({
      loanDoc: { status: 'paused', installments },
    });

    const result = await service.pauseResumeLoan(workspaceId, String(savedLoanDoc._id), userId, {
      action: 'resume',
    });

    expect(result.status).toBe('active');
    // materializeLoanInstallments was called (creates adjustment for the reversed installment).
    expect(adjustmentCtorMock).toHaveBeenCalled();
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'salary.loan.resumed' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Case K: pauseResumeLoan - pause already-paused throws
// ---------------------------------------------------------------------------

describe('pauseResumeLoan - double-pause', () => {
  it('throws BadRequestException when loan is already paused', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'paused', installments: [] },
    });

    await expect(
      service.pauseResumeLoan(workspaceId, String(savedLoanDoc._id), userId, {
        action: 'pause',
      }),
    ).rejects.toThrow("Cannot pause a loan with status 'paused'");
  });
});

// ---------------------------------------------------------------------------
// Case L: pauseResumeLoan - resume non-paused throws
// ---------------------------------------------------------------------------

describe('pauseResumeLoan - resume non-paused', () => {
  it('throws BadRequestException when loan is active (not paused)', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'active', installments: [] },
    });

    await expect(
      service.pauseResumeLoan(workspaceId, String(savedLoanDoc._id), userId, {
        action: 'resume',
      }),
    ).rejects.toThrow("Cannot resume a loan with status 'active'");
  });
});

// ---------------------------------------------------------------------------
// Case M: earlyPayoffLoan - full payoff
// ---------------------------------------------------------------------------

describe('earlyPayoffLoan - full payoff', () => {
  it('closes the loan with status=completed and closureType=early_payoff', async () => {
    const adjId = new Types.ObjectId();
    const installments = [
      makeInstallment({ index: 1, month: 7, year: 2026, adjustmentId: adjId, status: 'scheduled' }),
      makeInstallment({ index: 2, month: 8, year: 2026, status: 'scheduled' }),
    ];
    const adjDoc = makeAdjustmentDoc({ _id: adjId });
    const { service, savedLoanDoc, adjustmentCtorMock } = buildService({
      loanDoc: {
        status: 'active',
        installments,
        remainingAmount: 20000,
        remainingPrincipal: 20000,
      },
      adjustmentDocs: [adjDoc, makeAdjustmentDoc()],
    });

    const result = await service.earlyPayoffLoan(workspaceId, String(savedLoanDoc._id), userId, {
      payoffAmount: 20000,
      reason: 'Employee paying off',
    });

    expect(result.status).toBe('completed');
    expect(result.closureType).toBe('early_payoff');
    expect(result.remainingAmount).toBe(0);
    // No new deduction adjustments created (payoff removes them).
    expect(adjustmentCtorMock).not.toHaveBeenCalled();
  });

  it('clamps payoff amount to remaining and still closes the loan', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: {
        status: 'active',
        installments: [],
        remainingAmount: 15000,
        remainingPrincipal: 15000,
      },
    });

    const result = await service.earlyPayoffLoan(workspaceId, String(savedLoanDoc._id), userId, {
      payoffAmount: 99999,
      reason: 'Overpayment clamp',
    });

    expect(result.status).toBe('completed');
  });

  it('emits PostHog event salary.loan_early_payoff with isFullPayoff=true', async () => {
    const { service, savedLoanDoc, postHog } = buildService({
      loanDoc: {
        status: 'active',
        installments: [],
        remainingAmount: 10000,
        remainingPrincipal: 10000,
      },
    });

    await service.earlyPayoffLoan(workspaceId, String(savedLoanDoc._id), userId, {
      payoffAmount: 10000,
      reason: 'Test',
    });

    const call = postHog.capture.mock.calls[0][0];
    expect(call.event).toBe('salary.loan_early_payoff');
    expect(call.properties.isFullPayoff).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case N: earlyPayoffLoan - partial payoff
// ---------------------------------------------------------------------------

describe('earlyPayoffLoan - partial payoff', () => {
  it('reduces remainingAmount and keeps status=active', async () => {
    const installments = [
      makeInstallment({ index: 1, month: 7, year: 2026, status: 'scheduled' }),
      makeInstallment({ index: 2, month: 8, year: 2026, status: 'scheduled' }),
      makeInstallment({ index: 3, month: 9, year: 2026, status: 'scheduled' }),
    ];
    const { service, savedLoanDoc } = buildService({
      loanDoc: {
        status: 'active',
        installments,
        remainingAmount: 30000,
        remainingPrincipal: 30000,
        principalAmount: 30000,
        totalInterestScheduled: 0,
        tenorMonths: 3,
      },
    });

    const result = await service.earlyPayoffLoan(workspaceId, String(savedLoanDoc._id), userId, {
      payoffAmount: 10000,
      reason: 'Partial payment',
    });

    // remainingAmount reduced by 10000 (= 30000 - 10000 = 20000).
    expect(result.remainingAmount).toBe(20000);
    // Loan stays active (not full payoff).
    expect(result.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Case O: earlyPayoffLoan - illegal state
// ---------------------------------------------------------------------------

describe('earlyPayoffLoan - illegal state', () => {
  it('throws BadRequestException when loan is already completed', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'completed', installments: [] },
    });

    await expect(
      service.earlyPayoffLoan(workspaceId, String(savedLoanDoc._id), userId, {
        payoffAmount: 5000,
        reason: 'Test',
      }),
    ).rejects.toThrow("Cannot early-payoff a loan with status 'completed'");
  });
});

// ---------------------------------------------------------------------------
// Case P: topUpLoan - active loan creates new loan
// ---------------------------------------------------------------------------

describe('topUpLoan - active loan', () => {
  it('closes old loan as top_up_superseded and creates a new active loan', async () => {
    const { service, savedLoanDoc, loanCtorMock, auditService } = buildService({
      loanDoc: {
        status: 'active',
        installments: [
          makeInstallment({ index: 1, month: 7, year: 2026, status: 'scheduled' }),
          makeInstallment({ index: 2, month: 8, year: 2026, status: 'scheduled' }),
        ],
        remainingPrincipal: 20000,
        remainingAmount: 20000,
        principalAmount: 20000,
        totalInterestScheduled: 0,
        tenorMonths: 2,
      },
    });

    await service.topUpLoan(workspaceId, String(savedLoanDoc._id), userId, {
      additionalAmount: 10000,
      disbursementDate: '2026-07-01',
      reason: 'Additional needs',
    });

    // New loan constructor called once.
    expect(loanCtorMock).toHaveBeenCalledOnce();
    // Old loan closed as top_up_superseded.
    expect(savedLoanDoc.status).toBe('completed');
    expect(savedLoanDoc.closureType).toBe('top_up_superseded');
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'salary.loan.top_up' }),
    );
  });

  it('new loan principal = remainingPrincipal + additionalAmount', async () => {
    const { service, savedLoanDoc, loanCtorMock } = buildService({
      loanDoc: {
        status: 'active',
        installments: [makeInstallment({ index: 1, month: 7, year: 2026, status: 'scheduled' })],
        remainingPrincipal: 15000,
        remainingAmount: 15000,
        principalAmount: 15000,
        totalInterestScheduled: 0,
        tenorMonths: 1,
      },
    });

    await service.topUpLoan(workspaceId, String(savedLoanDoc._id), userId, {
      additionalAmount: 5000,
      disbursementDate: '2026-07-15',
      reason: 'Top-up',
    });

    const ctorCall = loanCtorMock.mock.calls[0][0];
    expect(ctorCall.principalAmount).toBe(20000); // 15000 + 5000
  });
});

// ---------------------------------------------------------------------------
// Case Q: topUpLoan - paused loan throws
// ---------------------------------------------------------------------------

describe('topUpLoan - paused loan', () => {
  it('throws BadRequestException when loan is paused', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'paused', installments: [], remainingPrincipal: 10000 },
    });

    await expect(
      service.topUpLoan(workspaceId, String(savedLoanDoc._id), userId, {
        additionalAmount: 5000,
        disbursementDate: '2026-07-01',
        reason: 'Test',
      }),
    ).rejects.toThrow('Cannot top up a paused loan');
  });
});

// ---------------------------------------------------------------------------
// Case R: writeOffLoan - active loan
// ---------------------------------------------------------------------------

describe('writeOffLoan - active loan', () => {
  it('transitions to written_off and records writeOffAmount', async () => {
    const adjDoc = makeAdjustmentDoc();
    const installments = [
      makeInstallment({
        index: 1,
        month: 7,
        year: 2026,
        adjustmentId: adjDoc._id,
        status: 'scheduled',
      }),
    ];
    const { service, savedLoanDoc, auditService } = buildService({
      loanDoc: { status: 'active', installments },
      adjustmentDocs: [adjDoc],
    });

    const result = await service.writeOffLoan(workspaceId, String(savedLoanDoc._id), userId, {
      writeOffAmount: 10000,
      reason: 'Employee absconded',
    });

    expect(result.status).toBe('written_off');
    expect(result.closureType).toBe('written_off');
    expect(result.writeOffAmount).toBe(10000);
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'salary.loan.written_off' }),
    );
  });

  it('does NOT create any salary adjustment for the write-off amount', async () => {
    const { service, savedLoanDoc, adjustmentCtorMock } = buildService({
      loanDoc: { status: 'active', installments: [] },
    });

    await service.writeOffLoan(workspaceId, String(savedLoanDoc._id), userId, {
      writeOffAmount: 5000,
      reason: 'Test',
    });

    // No new deduction adjustment created for the write-off itself
    // (the reversal of future adjustments uses reverseSingleAdjustment, not the constructor).
    expect(adjustmentCtorMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case S: writeOffLoan - illegal state
// ---------------------------------------------------------------------------

describe('writeOffLoan - illegal state', () => {
  it('throws BadRequestException when loan is already completed', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'completed', installments: [] },
    });

    await expect(
      service.writeOffLoan(workspaceId, String(savedLoanDoc._id), userId, {
        writeOffAmount: 1000,
        reason: 'Test',
      }),
    ).rejects.toThrow("Cannot write off a loan with status 'completed'");
  });

  it('throws BadRequestException when loan is already written_off', async () => {
    const { service, savedLoanDoc } = buildService({
      loanDoc: { status: 'written_off', installments: [] },
    });

    await expect(
      service.writeOffLoan(workspaceId, String(savedLoanDoc._id), userId, {
        writeOffAmount: 1000,
        reason: 'Double write-off attempt',
      }),
    ).rejects.toThrow("Cannot write off a loan with status 'written_off'");
  });
});
