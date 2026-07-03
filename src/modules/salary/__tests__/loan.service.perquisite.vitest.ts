/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Slice 4 - LoanService.computeMonthlyPerquisites unit tests.
 *
 * Covers the full perquisite valuation logic including:
 *   A. Zero-interest loan above Rs 2,00,000 threshold -> positive perquisite.
 *   B. Concessional rate (actual < benchmark) -> differential perquisite.
 *   C. Medical loan exempt (medicalLoanExempt=true) -> perquisiteValue=0.
 *   D. Aggregate outstanding <= threshold -> perquisiteValue=0 (threshold exempt).
 *   E. Full-market-rate loan (actual >= SBI benchmark) -> perquisiteValue=0.
 *   F. Idempotent: second call for same month is skipped.
 *   G. dryRun=true: returns values without writing adjustments.
 *
 * Strategy: mock all I/O (loanModel, salaryAdjustmentModel, salaryService
 * private methods, payrollConfigModel) and exercise the service-level
 * exemption + computation logic.
 *
 * The decorator mock must precede the LoanService import.
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
// Shared IDs
// ---------------------------------------------------------------------------

const workspaceId = new Types.ObjectId().toHexString();
const userId = new Types.ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal loan document shape used by computeMonthlyPerquisites.
 */
function makeLoan(overrides: {
  _id?: Types.ObjectId;
  teamMemberId?: Types.ObjectId;
  status?: string;
  interestType?: string;
  annualInterestRate?: number;
  remainingAmount?: number;
  medicalLoanExempt?: boolean;
  perquisiteHistory?: any[];
}) {
  const loan: any = {
    _id: overrides._id ?? new Types.ObjectId(),
    teamMemberId: overrides.teamMemberId ?? new Types.ObjectId(),
    workspaceId: new Types.ObjectId(workspaceId),
    status: overrides.status ?? 'active',
    interestType: overrides.interestType ?? 'zero',
    annualInterestRate: overrides.annualInterestRate ?? 0,
    remainingAmount: overrides.remainingAmount ?? 300_000,
    medicalLoanExempt: overrides.medicalLoanExempt ?? false,
    perquisiteHistory: overrides.perquisiteHistory ?? [],
    save: vi.fn().mockResolvedValue(undefined),
  };
  return loan;
}

/**
 * Build a minimal LoanService with all I/O mocked.
 * loanModelFind: what loanModel.find({ ... }).exec() returns.
 */
function buildService(loanModelFind: any[] = []) {
  const loanModel = {
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(loanModelFind) }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
  };

  const fakeSalaryRecord = { _id: new Types.ObjectId(), netSalary: 20_000 };
  const adjustmentSaveCapture: any[] = [];
  const adjustmentModel = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    aggregate: vi.fn().mockResolvedValue([]),
  };

  const salaryService: any = {
    getPayrollConfig: vi.fn().mockResolvedValue({
      loanConfig: { sbiBenchmarkRate: 8.65, perquisiteExemptionThreshold: 200_000 },
      features: { loanManagement: true },
    }),
    // private methods accessed via bracket notation
    ensureSalaryRecord: vi.fn().mockResolvedValue(fakeSalaryRecord),
    recalculateSalaryFromAdjustments: vi.fn().mockResolvedValue(undefined),
    teamModel: {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue({ salaryType: 'fixed', salaryAmount: 25_000 }),
          }),
        }),
      }),
    },
    salaryModel: {
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(fakeSalaryRecord) }),
    },
  };

  // The adjustment model constructor
  const AdjModel = function (data: any) {
    const obj = { ...data, _id: new Types.ObjectId(), save: vi.fn().mockResolvedValue(undefined) };
    adjustmentSaveCapture.push(obj);
    return obj;
  };
  AdjModel.find = adjustmentModel.find;
  AdjModel.aggregate = adjustmentModel.aggregate;

  const payrollConfigModel = {};
  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn() };
  const complianceGuard = new ComplianceGuardService();

  const service = new LoanService(
    loanModel as any,
    AdjModel as any,
    payrollConfigModel as any,
    salaryService,
    auditService as any,
    postHog as any,
    complianceGuard,
  );

  return { service, loanModel, salaryService, auditService, postHog, adjustmentSaveCapture };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('LoanService.computeMonthlyPerquisites', () => {
  // -------------------------------------------------------------------------
  // A. Zero-interest loan above threshold -> positive perquisite
  // -------------------------------------------------------------------------
  it('A. zero-interest loan above Rs 2,00,000 threshold produces positive perquisite', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 300_000, // above threshold
      medicalLoanExempt: false,
    });

    const { service, adjustmentSaveCapture } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    // perquisite = 300000 * (8.65 - 0) / 1200 = 2162.5
    expect(result.processed).toBe(1);
    expect(result.totalPerquisiteAmount).toBeCloseTo(2162.5, 0);
    expect(result.details[0].exempt).toBe(false);
    expect(result.details[0].reason).toBe('computed');
    // A loan_perquisite SalaryAdjustment must have been created.
    expect(adjustmentSaveCapture.length).toBe(1);
    expect(adjustmentSaveCapture[0].category).toBe('loan_perquisite');
    expect(adjustmentSaveCapture[0].type).toBe('addition');
    expect(adjustmentSaveCapture[0].amount).toBeCloseTo(2162.5, 0);
    // The perquisiteHistory entry must be appended to the loan.
    expect(loan.perquisiteHistory).toHaveLength(1);
    expect(loan.perquisiteHistory[0].perquisiteValue).toBeCloseTo(2162.5, 0);
    expect(loan.perquisiteHistory[0].exempt).toBe(false);
    expect(loan.save).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // B. Concessional rate -> differential perquisite
  // -------------------------------------------------------------------------
  it('B. concessional rate (actual < benchmark) computes differential perquisite', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'flat',
      annualInterestRate: 4, // below 8.65% benchmark
      remainingAmount: 400_000,
      medicalLoanExempt: false,
    });

    const { service } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    // perquisite = 400000 * (8.65 - 4) / 1200 = 400000 * 4.65 / 1200 = 1550
    expect(result.processed).toBe(1);
    expect(result.totalPerquisiteAmount).toBeCloseTo(1550, 0);
    expect(result.details[0].exempt).toBe(false);
    expect(loan.perquisiteHistory[0].perquisiteValue).toBeCloseTo(1550, 0);
    expect(loan.perquisiteHistory[0].sbiBenchmarkRate).toBe(8.65);
    expect(loan.perquisiteHistory[0].interestActuallyCharged).toBe(4);
  });

  // -------------------------------------------------------------------------
  // C. Medical loan exempt -> perquisiteValue=0, exempt=true
  // -------------------------------------------------------------------------
  it('C. medical loan exempt flag: perquisiteValue=0, exempt=true, no adjustment created', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 300_000,
      medicalLoanExempt: true, // exempt
    });

    const { service, adjustmentSaveCapture } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    expect(result.processed).toBe(0);
    expect(result.skippedExempt).toBe(1);
    expect(result.totalPerquisiteAmount).toBe(0);
    expect(result.details[0].exempt).toBe(true);
    expect(result.details[0].reason).toBe('medical_loan_exempt');
    // No adjustment must be created.
    expect(adjustmentSaveCapture).toHaveLength(0);
    expect(loan.perquisiteHistory[0].perquisiteValue).toBe(0);
    expect(loan.perquisiteHistory[0].exempt).toBe(true);
  });

  // -------------------------------------------------------------------------
  // D. Aggregate outstanding <= threshold -> exempt
  // -------------------------------------------------------------------------
  it('D. aggregate outstanding <= Rs 2,00,000 -> threshold exempt, no perquisite', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 150_000, // below Rs 2,00,000 threshold
      medicalLoanExempt: false,
    });

    const { service, adjustmentSaveCapture } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    expect(result.processed).toBe(0);
    expect(result.skippedExempt).toBe(1);
    expect(result.totalPerquisiteAmount).toBe(0);
    expect(result.details[0].exempt).toBe(true);
    expect(result.details[0].reason).toBe('aggregate_below_threshold');
    expect(adjustmentSaveCapture).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // D2. Two loans for the same member: aggregate ABOVE threshold even if
  //     individually below -> perquisite applies to both
  // -------------------------------------------------------------------------
  it('D2. two loans same member: aggregate > threshold -> both get perquisite', async () => {
    const memberId = new Types.ObjectId();
    const loan1 = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 120_000, // individually below threshold
      medicalLoanExempt: false,
    });
    const loan2 = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 100_000, // individually below threshold
      medicalLoanExempt: false,
    });
    // Aggregate = 220,000 which is above Rs 2,00,000 threshold.

    const { service } = buildService([loan1, loan2]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    // Both loans should produce perquisite since aggregate > threshold.
    expect(result.processed).toBe(2);
    expect(result.skippedExempt).toBe(0);
    expect(result.totalPerquisiteAmount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // E. Full-market-rate loan (actual >= SBI) -> no perquisite
  // -------------------------------------------------------------------------
  it('E. actual rate >= SBI benchmark -> no perquisite, no adjustment created', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'reducing_balance',
      annualInterestRate: 10, // above 8.65% benchmark
      remainingAmount: 500_000,
      medicalLoanExempt: false,
    });

    const { service, adjustmentSaveCapture } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    expect(result.processed).toBe(0);
    expect(result.totalPerquisiteAmount).toBe(0);
    expect(result.details[0].reason).toBe('rate_at_or_above_benchmark');
    expect(result.details[0].exempt).toBe(false);
    expect(adjustmentSaveCapture).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // F. Idempotent: second call for the same month is skipped
  // -------------------------------------------------------------------------
  it('F. idempotent: second run for same month/year is a no-op', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 300_000,
      medicalLoanExempt: false,
      // Pre-populated history for month 5/2026.
      perquisiteHistory: [
        {
          month: 5,
          year: 2026,
          outstandingAtStart: 300_000,
          sbiBenchmarkRate: 8.65,
          interestActuallyCharged: 0,
          perquisiteValue: 2162.5,
          exempt: false,
        },
      ],
    });

    const { service, adjustmentSaveCapture } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026 },
      userId,
    );

    expect(result.skippedIdempotent).toBe(1);
    expect(result.processed).toBe(0);
    // No new adjustment should be created.
    expect(adjustmentSaveCapture).toHaveLength(0);
    // The loan.save should NOT have been called (no mutation on idempotent skip).
    expect(loan.save).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // G. dryRun=true: returns values without writing adjustments
  // -------------------------------------------------------------------------
  it('G. dryRun=true: computes perquisite values but does not write adjustments or history', async () => {
    const memberId = new Types.ObjectId();
    const loan = makeLoan({
      teamMemberId: memberId,
      interestType: 'zero',
      annualInterestRate: 0,
      remainingAmount: 300_000,
      medicalLoanExempt: false,
    });

    const { service, adjustmentSaveCapture } = buildService([loan]);

    const result = await service.computeMonthlyPerquisites(
      workspaceId,
      { month: 5, year: 2026, dryRun: true },
      userId,
    );

    // Dry-run: result shows what would happen.
    expect(result.processed).toBe(1);
    expect(result.totalPerquisiteAmount).toBeCloseTo(2162.5, 0);
    // But no DB writes.
    expect(adjustmentSaveCapture).toHaveLength(0);
    expect(loan.save).not.toHaveBeenCalled();
    expect(loan.perquisiteHistory).toHaveLength(0);
  });
});
