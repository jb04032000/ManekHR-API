/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Slice 3 - FnF compliance unit tests.
 *
 * Covers computeFnfTotals (the pure computational core):
 *   1. Gratuity is NEVER consumed by advance recovery.
 *   2. Outstanding fully recoverable from non-gratuity dues - residual = 0.
 *   3. No outstanding advance - both new fields 0, netFnfPayable unchanged.
 *   4. Baseline parity: zero advance gives same netFnfPayable as old formula.
 *
 * Also covers finaliseFnf side-effects (plan closure + residual audit).
 *
 * Decorator mock is placed BEFORE FnfService import so transitive schema
 * @Prop/@Schema decorators are no-ops under vitest's esbuild transform.
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

import { Types } from 'mongoose';
import { FnfService } from '../fnf.service';

// ---------------------------------------------------------------------------
// Minimal settlement shape (all fields that computeFnfTotals reads)
// ---------------------------------------------------------------------------
function makeSettlement(
  overrides: Partial<{
    lastMonthNetSalary: number;
    leaveEncashmentAmount: number;
    gratuityAmount: number;
    noticeRecoveryAmount: number;
    outstandingAdvanceAmount: number;
    /** Slice 4 - outstanding employer loan balance at F&F time */
    outstandingLoanAmount: number;
    otherAdditions: Array<{ description: string; amount: number }>;
    otherDeductions: Array<{ description: string; amount: number }>;
  }> = {},
) {
  return {
    lastMonthNetSalary: 0,
    leaveEncashmentAmount: 0,
    gratuityAmount: 0,
    noticeRecoveryAmount: 0,
    outstandingAdvanceAmount: 0,
    outstandingLoanAmount: 0,
    otherAdditions: [] as Array<{ description: string; amount: number }>,
    otherDeductions: [] as Array<{ description: string; amount: number }>,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build a minimal FnfService with all deps mocked.
// computeFnfTotals is a pure function that only reads the settlement object,
// so we only need enough mocks to satisfy the constructor.
// ---------------------------------------------------------------------------
function buildService(employerLoanModelOverride?: any) {
  const noopModel = () => ({
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    aggregate: vi.fn().mockResolvedValue([]),
  });

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const gratuityService = { computeFnfGratuity: vi.fn() };

  const service = new FnfService(
    noopModel() as any, // fnfModel
    noopModel() as any, // salaryModel
    noopModel() as any, // adjustmentModel
    noopModel() as any, // teamModel
    noopModel() as any, // leaveBalanceModel
    noopModel() as any, // leaveTypeModel
    noopModel() as any, // encashmentModel
    noopModel() as any, // advancePlanModel
    // employerLoanModel - Slice 4 addition. Default to noopModel if not overridden.
    employerLoanModelOverride ?? (noopModel() as any),
    // payrollConfigModel - Phase 3A bonus clawback config read.
    noopModel() as any,
    gratuityService as any,
    auditService as any,
  );

  return { service, auditService };
}

// ---------------------------------------------------------------------------
// computeFnfTotals
// ---------------------------------------------------------------------------
describe('FnfService.computeFnfTotals — gratuity protection', () => {
  let svc: FnfService;

  beforeEach(() => {
    const ctx = buildService();
    svc = ctx.service;
  });

  it('gratuity is NEVER consumed: advance > nonGratuityEarnings, gratuity is large', () => {
    // Setup: non-gratuity pool = 5,000 (lastMonthNetSalary), gratuity = 50,000.
    // Outstanding advance = 8,000 (larger than the non-gratuity pool).
    // Expected: advanceRecoverableFromDues = 5,000 (capped at pool),
    //           advanceResidualUnrecovered = 3,000 (8000 - 5000),
    //           netFnfPayable = 5,000 + 50,000 - 5,000 = 50,000 (gratuity intact).
    const settlement = makeSettlement({
      lastMonthNetSalary: 5_000,
      gratuityAmount: 50_000,
      outstandingAdvanceAmount: 8_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(5_000);
    expect(result.advanceResidualUnrecovered).toBe(3_000);
    // Gratuity must be intact in netFnfPayable (not consumed by advance).
    expect(result.netFnfPayable).toBe(50_000);
    // totalEarnings = 5,000 (nonGratuity) + 50,000 (gratuity)
    expect(result.totalEarnings).toBe(55_000);
    // totalDeductions = 0 (otherDeductions) + 5,000 (advanceRecoverable)
    expect(result.totalDeductions).toBe(5_000);
  });

  it('gratuity is NEVER consumed: outstanding > pool after noticeRecovery, gratuity remains', () => {
    // Non-gratuity pool: 10,000 lastMonthNetSalary + 2,000 leaveEncashment = 12,000.
    // Notice recovery deduction: 4,000. Available for advance = 12,000 - 4,000 = 8,000.
    // Outstanding advance: 15,000. RecoverableFromDues = 8,000. Residual = 7,000.
    // Gratuity: 30,000. netFnfPayable = 12,000 + 30,000 - 4,000 - 8,000 = 30,000.
    const settlement = makeSettlement({
      lastMonthNetSalary: 10_000,
      leaveEncashmentAmount: 2_000,
      gratuityAmount: 30_000,
      noticeRecoveryAmount: 4_000,
      outstandingAdvanceAmount: 15_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(8_000);
    expect(result.advanceResidualUnrecovered).toBe(7_000);
    // Gratuity is untouched: net = totalEarnings - totalDeductions
    // = (10,000 + 2,000 + 30,000) - (4,000 + 8,000) = 42,000 - 12,000 = 30,000
    expect(result.netFnfPayable).toBe(30_000);
    expect(result.totalEarnings).toBe(42_000);
    expect(result.totalDeductions).toBe(12_000);
  });

  it('outstanding fully recoverable from non-gratuity dues - residual is 0', () => {
    // Non-gratuity pool: 20,000. Outstanding advance: 5,000.
    // Available = 20,000 - 0 (no other deductions) = 20,000.
    // advanceRecoverableFromDues = 5,000, residual = 0.
    const settlement = makeSettlement({
      lastMonthNetSalary: 20_000,
      gratuityAmount: 10_000,
      outstandingAdvanceAmount: 5_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(5_000);
    expect(result.advanceResidualUnrecovered).toBe(0);
    // netFnfPayable = (20,000 + 10,000) - (0 + 5,000) = 25,000
    expect(result.netFnfPayable).toBe(25_000);
  });

  it('no outstanding advance - both new fields are 0, netFnfPayable is correct', () => {
    const settlement = makeSettlement({
      lastMonthNetSalary: 15_000,
      leaveEncashmentAmount: 3_000,
      gratuityAmount: 20_000,
      noticeRecoveryAmount: 2_000,
      outstandingAdvanceAmount: 0,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(0);
    expect(result.advanceResidualUnrecovered).toBe(0);
    // netFnfPayable = (15,000 + 3,000 + 20,000) - 2,000 = 36,000
    expect(result.netFnfPayable).toBe(36_000);
    expect(result.totalEarnings).toBe(38_000);
    expect(result.totalDeductions).toBe(2_000);
  });

  it('baseline parity: zero advance gives same netFnfPayable as old formula would', () => {
    // Old formula: earnings = lastMonthNet + gratuity + leaveEncashment
    //              deductions = noticeRecovery + outstandingAdvance (0)
    //              net = max(earnings - deductions, 0)
    // New formula must match exactly for the zero-advance case.
    const settlement = makeSettlement({
      lastMonthNetSalary: 12_000,
      leaveEncashmentAmount: 4_000,
      gratuityAmount: 25_000,
      noticeRecoveryAmount: 6_000,
      outstandingAdvanceAmount: 0,
    });

    const result = svc.computeFnfTotals(settlement);

    // Old formula result:
    const oldEarnings = 12_000 + 25_000 + 4_000; // 41,000
    const oldDeductions = 6_000 + 0;
    const oldNet = Math.max(oldEarnings - oldDeductions, 0); // 35,000

    expect(result.netFnfPayable).toBe(oldNet);
    expect(result.advanceRecoverableFromDues).toBe(0);
    expect(result.advanceResidualUnrecovered).toBe(0);
  });

  it('otherAdditions and otherDeductions are correctly included', () => {
    // Non-gratuity: 10,000 net + 2,000 (other addition) = 12,000.
    // Other deductions: 1,000 (misc) + 500 (misc2) = 1,500.
    // Available for advance: 12,000 - 1,500 = 10,500.
    // Outstanding advance: 7,000. Recoverable = 7,000. Residual = 0.
    // Gratuity: 5,000.
    // Total earnings = 12,000 + 5,000 = 17,000.
    // Total deductions = 1,500 + 7,000 = 8,500.
    // Net = 17,000 - 8,500 = 8,500.
    const settlement = makeSettlement({
      lastMonthNetSalary: 10_000,
      gratuityAmount: 5_000,
      outstandingAdvanceAmount: 7_000,
      otherAdditions: [{ description: 'Bonus', amount: 2_000 }],
      otherDeductions: [
        { description: 'Uniform deduction', amount: 1_000 },
        { description: 'Tool damage', amount: 500 },
      ],
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(7_000);
    expect(result.advanceResidualUnrecovered).toBe(0);
    expect(result.totalEarnings).toBe(17_000);
    expect(result.totalDeductions).toBe(8_500);
    expect(result.netFnfPayable).toBe(8_500);
  });

  it('net cannot go below 0 when deductions exceed earnings', () => {
    // Non-gratuity: 2,000. Other deductions: 500. Available: 1,500.
    // Outstanding: 1,500. Recoverable: 1,500. Residual: 0.
    // Gratuity: 0. Total earnings: 2,000. Total deductions: 2,000.
    // Net = max(0, 0) = 0.
    const settlement = makeSettlement({
      lastMonthNetSalary: 2_000,
      gratuityAmount: 0,
      outstandingAdvanceAmount: 1_500,
      otherDeductions: [{ description: 'misc', amount: 500 }],
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.netFnfPayable).toBe(0);
    expect(result.advanceRecoverableFromDues).toBe(1_500);
    expect(result.advanceResidualUnrecovered).toBe(0);
  });

  it('advance residual > 0 when pool is entirely consumed by other deductions', () => {
    // Non-gratuity: 3,000. Other deductions: 3,000.
    // Available for advance: max(0, 3,000 - 3,000) = 0.
    // Outstanding: 5,000. Recoverable = 0. Residual = 5,000.
    // Gratuity: 10,000. Net = (3,000 + 10,000) - (3,000 + 0) = 10,000.
    const settlement = makeSettlement({
      lastMonthNetSalary: 3_000,
      gratuityAmount: 10_000,
      outstandingAdvanceAmount: 5_000,
      noticeRecoveryAmount: 3_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(0);
    expect(result.advanceResidualUnrecovered).toBe(5_000);
    // Gratuity is still paid out in full.
    expect(result.netFnfPayable).toBe(10_000);
    expect(result.totalEarnings).toBe(13_000);
    expect(result.totalDeductions).toBe(3_000);
  });
});

// ---------------------------------------------------------------------------
// finaliseFnf - plan closure and residual audit
// ---------------------------------------------------------------------------
describe('FnfService.finaliseFnf — plan closure + residual audit', () => {
  it('closes active plans and emits residual audit when advanceResidualUnrecovered > 0', async () => {
    const wsId = new Types.ObjectId();
    const memberId = new Types.ObjectId();
    const userId = new Types.ObjectId().toHexString();
    const settlementId = new Types.ObjectId();

    const settlementDoc = {
      _id: settlementId,
      status: 'draft',
      advanceResidualUnrecovered: 3_000,
      advanceRecoverableFromDues: 5_000,
      outstandingAdvanceAmount: 8_000,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const plan1 = {
      _id: new Types.ObjectId(),
      status: 'active',
      closureType: undefined,
      closureReason: undefined,
      closedBy: undefined,
      closedAt: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const gratuityService = { computeFnfGratuity: vi.fn() };

    const fnfModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(settlementDoc) }),
    };

    const advancePlanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([plan1]) }),
    };

    const noopModel = () => ({
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      aggregate: vi.fn().mockResolvedValue([]),
    });

    const service = new FnfService(
      fnfModel as any,
      noopModel() as any, // salaryModel
      noopModel() as any, // adjustmentModel
      noopModel() as any, // teamModel
      noopModel() as any, // leaveBalanceModel
      noopModel() as any, // leaveTypeModel
      noopModel() as any, // encashmentModel
      advancePlanModel as any,
      noopModel() as any, // employerLoanModel (Slice 4)
      noopModel() as any, // payrollConfigModel (Phase 3A)
      gratuityService as any,
      auditService as any,
    );

    await service.finaliseFnf(wsId.toHexString(), memberId.toHexString(), userId);

    // Plan must be closed.
    expect(plan1.status).toBe('completed');
    expect(plan1.closureType).toBe('completed');
    expect(plan1.closureReason).toBe('fnf_settled');
    expect(plan1.save).toHaveBeenCalled();

    // Residual audit event must be emitted.
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'salary.fnf.advance_residual_unrecovered',
        meta: expect.objectContaining({ residualAmount: 3_000 }),
      }),
    );

    // Settlement must be finalised.
    expect(settlementDoc.status).toBe('finalised');
    expect(settlementDoc.save).toHaveBeenCalled();
  });

  it('skips residual audit when advanceResidualUnrecovered is 0', async () => {
    const wsId = new Types.ObjectId();
    const memberId = new Types.ObjectId();
    const userId = new Types.ObjectId().toHexString();

    const settlementDoc = {
      _id: new Types.ObjectId(),
      status: 'draft',
      advanceResidualUnrecovered: 0,
      advanceRecoverableFromDues: 5_000,
      outstandingAdvanceAmount: 5_000,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const gratuityService = { computeFnfGratuity: vi.fn() };

    const fnfModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(settlementDoc) }),
    };
    const advancePlanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const noopModel = () => ({
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      aggregate: vi.fn().mockResolvedValue([]),
    });

    const service = new FnfService(
      fnfModel as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      advancePlanModel as any,
      noopModel() as any, // employerLoanModel (Slice 4)
      noopModel() as any, // payrollConfigModel (Phase 3A)
      gratuityService as any,
      auditService as any,
    );

    await service.finaliseFnf(wsId.toHexString(), memberId.toHexString(), userId);

    // No residual - no audit event.
    expect(auditService.logEvent).not.toHaveBeenCalled();
    expect(settlementDoc.status).toBe('finalised');
  });

  it('closes multiple active plans on finaliseFnf', async () => {
    const wsId = new Types.ObjectId();
    const memberId = new Types.ObjectId();
    const userId = new Types.ObjectId().toHexString();

    const settlementDoc = {
      _id: new Types.ObjectId(),
      status: 'draft',
      advanceResidualUnrecovered: 0,
      advanceRecoverableFromDues: 0,
      outstandingAdvanceAmount: 0,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const makePlan = (status: string) => ({
      _id: new Types.ObjectId(),
      status,
      closureType: undefined as any,
      closureReason: undefined as any,
      closedBy: undefined as any,
      closedAt: undefined as any,
      save: vi.fn().mockResolvedValue(undefined),
    });

    const plan1 = makePlan('active');
    const plan2 = makePlan('paused');

    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const gratuityService = { computeFnfGratuity: vi.fn() };

    const fnfModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(settlementDoc) }),
    };
    const advancePlanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([plan1, plan2]) }),
    };
    const noopModel = () => ({
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      aggregate: vi.fn().mockResolvedValue([]),
    });

    const service = new FnfService(
      fnfModel as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      advancePlanModel as any,
      noopModel() as any, // employerLoanModel (Slice 4)
      noopModel() as any, // payrollConfigModel (Phase 3A)
      gratuityService as any,
      auditService as any,
    );

    await service.finaliseFnf(wsId.toHexString(), memberId.toHexString(), userId);

    for (const plan of [plan1, plan2]) {
      expect(plan.status).toBe('completed');
      expect(plan.closureType).toBe('completed');
      expect(plan.closureReason).toBe('fnf_settled');
      expect(plan.save).toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 4 - computeFnfTotals: loan recovery (parallel to advance recovery)
// ---------------------------------------------------------------------------
describe('FnfService.computeFnfTotals — Slice 4 loan recovery', () => {
  let svc: FnfService;

  beforeEach(() => {
    const ctx = buildService();
    svc = ctx.service;
  });

  it('outstanding loan fully recoverable from non-gratuity dues after advance', () => {
    // Non-gratuity: 20,000. No advance. Loan: 5,000.
    // Available for advance = 20,000 - 0 = 20,000. Advance = 0, pool remains 20,000.
    // Available for loan = 20,000. Loan recoverable = 5,000. Residual = 0.
    // Gratuity: 10,000. Net = (20,000 + 10,000) - (0 + 5,000) = 25,000.
    const settlement = makeSettlement({
      lastMonthNetSalary: 20_000,
      gratuityAmount: 10_000,
      outstandingAdvanceAmount: 0,
      outstandingLoanAmount: 5_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.loanRecoverableFromDues).toBe(5_000);
    expect(result.loanResidualUnrecovered).toBe(0);
    expect(result.netFnfPayable).toBe(25_000);
    expect(result.totalDeductions).toBe(5_000);
    expect(result.totalEarnings).toBe(30_000);
  });

  it('gratuity is NEVER consumed by loan recovery', () => {
    // Non-gratuity: 5,000. Loan: 8,000 (exceeds pool).
    // Available for loan = 5,000. Recoverable = 5,000. Residual = 3,000.
    // Gratuity: 50,000. Net = (5,000 + 50,000) - 5,000 = 50,000 (gratuity intact).
    const settlement = makeSettlement({
      lastMonthNetSalary: 5_000,
      gratuityAmount: 50_000,
      outstandingAdvanceAmount: 0,
      outstandingLoanAmount: 8_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.loanRecoverableFromDues).toBe(5_000);
    expect(result.loanResidualUnrecovered).toBe(3_000);
    // Gratuity must be intact.
    expect(result.netFnfPayable).toBe(50_000);
    expect(result.totalEarnings).toBe(55_000);
  });

  it('both advance and loan outstanding - advance recovered first, loan gets remainder', () => {
    // Non-gratuity: 15,000. Notice recovery: 2,000.
    // Available for advance = 15,000 - 2,000 = 13,000.
    // Outstanding advance: 8,000. Recoverable = 8,000. Pool after advance = 5,000.
    // Outstanding loan: 6,000. Recoverable = min(6,000, 5,000) = 5,000. Residual = 1,000.
    // Gratuity: 20,000.
    // Total earnings = 15,000 + 20,000 = 35,000.
    // Total deductions = 2,000 + 8,000 + 5,000 = 15,000.
    // Net = 35,000 - 15,000 = 20,000.
    const settlement = makeSettlement({
      lastMonthNetSalary: 15_000,
      gratuityAmount: 20_000,
      noticeRecoveryAmount: 2_000,
      outstandingAdvanceAmount: 8_000,
      outstandingLoanAmount: 6_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(8_000);
    expect(result.advanceResidualUnrecovered).toBe(0);
    expect(result.loanRecoverableFromDues).toBe(5_000);
    expect(result.loanResidualUnrecovered).toBe(1_000);
    expect(result.netFnfPayable).toBe(20_000);
    expect(result.totalDeductions).toBe(15_000);
  });

  it('no outstanding loans - loanRecoverableFromDues=0, loanResidual=0, net unchanged', () => {
    const settlement = makeSettlement({
      lastMonthNetSalary: 12_000,
      gratuityAmount: 8_000,
      noticeRecoveryAmount: 1_000,
      outstandingAdvanceAmount: 2_000,
      outstandingLoanAmount: 0,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.loanRecoverableFromDues).toBe(0);
    expect(result.loanResidualUnrecovered).toBe(0);
    // Net: (12,000 + 8,000) - (1,000 + 2,000) = 17,000.
    expect(result.netFnfPayable).toBe(17_000);
  });

  it('advance exhausts entire pool: loan gets nothing, full residual', () => {
    // Non-gratuity: 10,000. Outstanding advance: 10,000 (exhausts pool).
    // Available for loan: max(0, 10,000 - 10,000) = 0.
    // Outstanding loan: 5,000. Recoverable = 0. Residual = 5,000.
    // Gratuity: 15,000. Net = (10,000 + 15,000) - (10,000 + 0) = 15,000.
    const settlement = makeSettlement({
      lastMonthNetSalary: 10_000,
      gratuityAmount: 15_000,
      outstandingAdvanceAmount: 10_000,
      outstandingLoanAmount: 5_000,
    });

    const result = svc.computeFnfTotals(settlement);

    expect(result.advanceRecoverableFromDues).toBe(10_000);
    expect(result.advanceResidualUnrecovered).toBe(0);
    expect(result.loanRecoverableFromDues).toBe(0);
    expect(result.loanResidualUnrecovered).toBe(5_000);
    // Gratuity untouched.
    expect(result.netFnfPayable).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// Slice 4 - finaliseFnf: closes active loans
// ---------------------------------------------------------------------------
describe('FnfService.finaliseFnf — Slice 4 loan closure', () => {
  it('closes active loans with written_off when remainingAmount > 0', async () => {
    const wsId = new Types.ObjectId();
    const memberId = new Types.ObjectId();
    const userId = new Types.ObjectId().toHexString();

    const settlementDoc = {
      _id: new Types.ObjectId(),
      status: 'draft',
      advanceResidualUnrecovered: 0,
      outstandingAdvanceAmount: 0,
      outstandingLoanAmount: 5_000,
      loanResidualNote: 'Rs 5000 residual',
      totalDeductions: 0,
      noticeRecoveryAmount: 0,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const loan = {
      _id: new Types.ObjectId(),
      status: 'active',
      remainingAmount: 5_000,
      closureType: undefined as any,
      closureReason: undefined as any,
      closedBy: undefined as any,
      closedAt: undefined as any,
      writeOffAmount: undefined as any,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const gratuityService = { computeFnfGratuity: vi.fn() };

    const fnfModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(settlementDoc) }),
    };
    const advancePlanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const employerLoanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([loan]) }),
    };
    const noopModel = () => ({
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      aggregate: vi.fn().mockResolvedValue([]),
    });

    const service = new FnfService(
      fnfModel as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      advancePlanModel as any,
      employerLoanModel as any,
      noopModel() as any, // payrollConfigModel (Phase 3A)
      gratuityService as any,
      auditService as any,
    );

    await service.finaliseFnf(wsId.toHexString(), memberId.toHexString(), userId);

    // Loan with remaining balance must be written_off.
    expect(loan.status).toBe('written_off');
    expect(loan.closureType).toBe('written_off');
    expect(loan.closureReason).toBe('fnf_settled');
    expect(loan.writeOffAmount).toBe(5_000);
    expect(loan.save).toHaveBeenCalled();

    // Settlement must be finalised.
    expect(settlementDoc.status).toBe('finalised');
    expect(settlementDoc.save).toHaveBeenCalled();
  });

  it('closes fully recovered loan with completed (no write-off)', async () => {
    const wsId = new Types.ObjectId();
    const memberId = new Types.ObjectId();
    const userId = new Types.ObjectId().toHexString();

    const settlementDoc = {
      _id: new Types.ObjectId(),
      status: 'draft',
      advanceResidualUnrecovered: 0,
      outstandingAdvanceAmount: 0,
      outstandingLoanAmount: 0,
      loanResidualNote: '',
      totalDeductions: 0,
      noticeRecoveryAmount: 0,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const loan = {
      _id: new Types.ObjectId(),
      status: 'active',
      remainingAmount: 0, // fully recovered
      closureType: undefined as any,
      closureReason: undefined as any,
      closedBy: undefined as any,
      closedAt: undefined as any,
      writeOffAmount: undefined as any,
      save: vi.fn().mockResolvedValue(undefined),
    };

    const fnfModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(settlementDoc) }),
    };
    const advancePlanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const employerLoanModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([loan]) }),
    };
    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const gratuityService = { computeFnfGratuity: vi.fn() };
    const noopModel = () => ({
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      aggregate: vi.fn().mockResolvedValue([]),
    });

    const service = new FnfService(
      fnfModel as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      noopModel() as any,
      advancePlanModel as any,
      employerLoanModel as any,
      noopModel() as any, // payrollConfigModel (Phase 3A)
      gratuityService as any,
      auditService as any,
    );

    await service.finaliseFnf(wsId.toHexString(), memberId.toHexString(), userId);

    // Fully recovered loan uses 'completed' not 'written_off'.
    expect(loan.status).toBe('completed');
    expect(loan.closureType).toBe('completed');
    expect(loan.closureReason).toBe('fnf_settled');
    // writeOffAmount must not be set when fully recovered.
    expect(loan.writeOffAmount).toBeUndefined();
    expect(loan.save).toHaveBeenCalled();
  });
});
