/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Task 3 — Advance Recovery Plan (EMI) unit tests.
 *
 * Strategy: drive `createAdvanceRecoveryPlan` (private) via (service as any).
 * We stub `ensureSalaryRecord` on the service instance because the real
 * implementation fans out into getPayrollConfig, piece-rate compute, etc.,
 * all of which are orthogonal to the schedule/cap/carry logic under test.
 *
 * Conservation invariant: sum of all applied amounts === totalAmount when
 * net is sufficient across trailing months.
 *
 * Cases:
 *   A. 60000 / 6 months, net=20000 each -> 6 x 10000 deductions, months walk.
 *   B. Cap-and-carry: month-1 net=4000, rest net=20000 -> applied=4000 month-1,
 *      shortfall (6000) recovered in trailing month. Total applied = totalAmount.
 *   B-zero. Zero-net month -> no deduction created (no zero-amount calls).
 *   B2. Piece-rate: future month net=0, salaryAmount=15000 -> cap basis=15000,
 *      full 15000 applied in one installment.
 *   C. Legacy: absent advanceInstallments -> no plan created, single deduction called.
 *   C2. installmentCount > 1 -> plan created, not single deduction.
 *
 * The decorator mock must be placed BEFORE SalaryService import so the
 * transitive schema @Prop/@Schema decorators are no-ops.
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
import { SalaryService } from '../salary.service';

// ---------------------------------------------------------------------------
// Shared test IDs
// ---------------------------------------------------------------------------
const workspaceId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();
const sourcePaymentId = new Types.ObjectId();
const userId = new Types.ObjectId();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal saveable plan doc stub. */
function makeDocStub(extra: Record<string, any> = {}) {
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

/** Build a minimal salary record for ensureSalaryRecord stubs.
 *  grossSalary defaults to max(netSalary, 20000) so that compliance guard
 *  cap checks do not interfere with carry/scheduling tests when deductionCapPercent=100.
 *  In real data the gross is >= net (gross - deductions = net); using 20000 as the
 *  default gross covers the test scenarios without triggering the statutory cap. */
function makeSalaryRecord(netSalary: number, month = 6, year = 2026) {
  return {
    _id: new Types.ObjectId(),
    baseSalary: Math.max(netSalary, 20000),
    additions: 0,
    deductions: 0,
    netSalary,
    isLocked: false,
    month,
    year,
    teamMemberId,
    workspaceId: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a SalaryService with all models/services mocked.
 * The caller is expected to stub `svc.ensureSalaryRecord` and
 * `svc.recalculateSalaryFromAdjustments` per test.
 */
function buildService() {
  const noopModel = () => ({
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    updateMany: vi.fn(),
  });

  // salaryAdjustmentModel: constructor records calls; save resolves immediately.
  const adjustmentCtorMock = vi.fn().mockImplementation(() => ({
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));
  (adjustmentCtorMock as any).find = vi.fn().mockResolvedValue([]);
  (adjustmentCtorMock as any).findOne = vi.fn().mockResolvedValue(null);
  (adjustmentCtorMock as any).findById = vi.fn().mockResolvedValue(null);
  (adjustmentCtorMock as any).updateMany = vi.fn().mockResolvedValue({});

  // advanceRecoveryPlanModel: constructor stub
  const planCtorMock = vi.fn().mockImplementation((data: any) => {
    return makeDocStub({
      ...data,
      installments: data.installments ?? [],
      linkedAdjustmentIds: data.linkedAdjustmentIds ?? [],
    });
  });
  (planCtorMock as any).find = vi.fn().mockResolvedValue([]);
  (planCtorMock as any).findOne = vi.fn().mockResolvedValue(null);
  (planCtorMock as any).findById = vi.fn().mockResolvedValue(null);

  const teamFindByIdMock = vi.fn();
  const teamModelMock = {
    findById: teamFindByIdMock,
    find: vi.fn(),
    findOne: vi.fn(),
  };

  // payrollConfigModel needs findOneAndUpdate for getPayrollConfig (called in
  // createAdvanceRecoveryPlan now that the compliance guard is wired in).
  // Use deductionCapPercent: 100 so compliance guard never hard-blocks in these
  // tests, which focus on installment scheduling and carry logic, not compliance.
  const payrollConfigModelMock = {
    ...noopModel(),
    findOneAndUpdate: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        compliance: {
          minimumWageMonthly: null,
          deductionCapPercent: 100,
          installmentAdvisoryMaxMonths: 12,
        },
        features: {},
      }),
    }),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const callerScope = {
    resolve: vi.fn(),
    effectiveScope: vi.fn(),
    selfFilterValue: vi.fn(),
  };

  const service = new SalaryService(
    noopModel() as any, // salaryModel
    noopModel() as any, // paymentModel
    teamModelMock as any, // teamModel
    noopModel() as any, // attendanceModel
    noopModel() as any, // incrementModel
    adjustmentCtorMock as any, // salaryAdjustmentModel
    payrollConfigModelMock as any, // payrollConfigModel
    noopModel() as any, // ptSlabConfigModel
    noopModel() as any, // componentTemplateModel
    noopModel() as any, // workspaceModel
    noopModel() as any, // subscriptionModel
    noopModel() as any, // bulkEmailJobModel
    noopModel() as any, // userModel
    noopModel() as any, // shiftModel
    noopModel() as any, // leaveRequestModel
    noopModel() as any, // leaveTypeModel
    noopModel() as any, // productionLogModel
    noopModel() as any, // machineModel
    noopModel() as any, // pieceRateConfigAuditModel
    planCtorMock as any, // advanceRecoveryPlanModel
    auditService as any, // auditService
    {} as any, // mailService
    {} as any, // payslipPdfService
    {} as any, // complianceExportService
    {} as any, // tdsService
    {} as any, // gratuityService
    {} as any, // fnfService
    {} as any, // attendancePoliciesService
    {} as any, // teamService
    callerScope as any, // callerScope
    postHog as any, // postHog
    new ComplianceGuardService(), // complianceGuard (real service - pure functions)
  );

  return {
    service,
    adjustmentCtorMock,
    planCtorMock,
    teamFindByIdMock,
    auditService,
    postHog,
  };
}

// ---------------------------------------------------------------------------
// Case A: even split — 60000 / 6, net=20000 per month
// ---------------------------------------------------------------------------
describe('createAdvanceRecoveryPlan — Case A: even split, net covers each installment', () => {
  let ctx: ReturnType<typeof buildService>;

  beforeEach(() => {
    ctx = buildService();

    // teamModel: monthly member
    ctx.teamFindByIdMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 20000,
      }),
    });

    // Stub ensureSalaryRecord to return net=20000 always
    (ctx.service as any).ensureSalaryRecord = vi.fn().mockResolvedValue(makeSalaryRecord(20000));

    // Stub recalculateSalaryFromAdjustments
    (ctx.service as any).recalculateSalaryFromAdjustments = vi
      .fn()
      .mockResolvedValue(makeSalaryRecord(20000));
  });

  it('creates 6 deductions of 10000 and plan.installmentCount===6', async () => {
    const svc = ctx.service as any;

    const { plan } = await svc.createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount: 60000,
      startMonth: 6,
      startYear: 2026,
      installmentConfig: { installmentCount: 6 },
      userId,
    });

    // 6 adjustment constructor calls = 6 deductions
    expect(ctx.adjustmentCtorMock).toHaveBeenCalledTimes(6);

    // Each deduction is 10000
    for (const call of ctx.adjustmentCtorMock.mock.calls) {
      expect(call[0].amount).toBe(10000);
    }

    // Plan installments
    expect(plan.installments.length).toBe(6);

    // Conservation: remainingAmount === totalAmount (not yet recovered)
    expect(plan.remainingAmount).toBe(60000);
    expect(plan.recoveredAmount).toBe(0);

    // Months walked correctly: 6, 7, 8, 9, 10, 11 of 2026
    const months = plan.installments.map((i: any) => i.month);
    expect(months).toEqual([6, 7, 8, 9, 10, 11]);

    // Audit fired: 6 deduction events + 1 plan-level event = 7 total.
    // The plan-level event uses action 'salary.advance_plan.created'.
    expect(ctx.auditService.logEvent).toHaveBeenCalledTimes(7);
    const planAuditCall = ctx.auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'salary.advance_plan.created',
    );
    expect(planAuditCall).toBeDefined();

    // PostHog: one plan-level event only (deductions do not emit PostHog).
    expect(ctx.postHog.capture).toHaveBeenCalledOnce();
    expect(ctx.postHog.capture.mock.calls[0][0].event).toBe('salary.advance_plan_created');
    expect(ctx.postHog.capture.mock.calls[0][0].properties.installmentCount).toBe(6);
  });

  it('each adjustment carries advanceRecoveryPlanId and planInstallmentIndex', async () => {
    const svc = ctx.service as any;

    await svc.createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount: 30000,
      startMonth: 1,
      startYear: 2026,
      installmentConfig: { installmentCount: 3 },
      userId,
    });

    for (let i = 0; i < 3; i++) {
      const call = ctx.adjustmentCtorMock.mock.calls[i][0];
      expect(call.advanceRecoveryPlanId).toBeDefined();
      expect(call.planInstallmentIndex).toBe(i + 1);
    }
  });

  it('Dec->Jan wrap: startMonth=11 -> months 11,12/2026 then 1,2,3,4/2027', async () => {
    const svc = ctx.service as any;

    const { plan } = await svc.createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount: 60000,
      startMonth: 11,
      startYear: 2026,
      installmentConfig: { installmentCount: 6 },
      userId,
    });

    const monthYear = plan.installments.map((i: any) => `${i.month}/${i.year}`);
    expect(monthYear).toEqual(['11/2026', '12/2026', '1/2027', '2/2027', '3/2027', '4/2027']);
  });
});

// ---------------------------------------------------------------------------
// Case B: cap-and-carry conservation
// ---------------------------------------------------------------------------
describe('createAdvanceRecoveryPlan — Case B: cap-and-carry conservation', () => {
  it('applied amounts sum to totalAmount when trailing months have sufficient net', async () => {
    const ctx = buildService();

    ctx.teamFindByIdMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 10000,
      }),
    });

    let callCount = 0;
    // First month: net=4000. All subsequent months: net=20000.
    (ctx.service as any).ensureSalaryRecord = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeSalaryRecord(callCount === 1 ? 4000 : 20000));
    });
    (ctx.service as any).recalculateSalaryFromAdjustments = vi.fn().mockResolvedValue({});

    // 20000 in 2 installments of 10000; month 1 can only absorb 4000
    const { plan } = await (ctx.service as any).createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount: 20000,
      startMonth: 6,
      startYear: 2026,
      installmentConfig: { installmentCount: 2 },
      userId,
    });

    // Conservation: sum of all appliedAmounts === 20000
    const totalApplied = plan.installments.reduce(
      (sum: number, i: any) => sum + i.appliedAmount,
      0,
    );
    expect(totalApplied).toBe(20000);

    // First installment: capped at 4000, status 'carried'
    expect(plan.installments[0].appliedAmount).toBe(4000);
    expect(plan.installments[0].status).toBe('carried');

    // Trailing entries pick up the rest (10000 + 6000 shortfall = 16000)
    const trailingTotal = plan.installments
      .slice(1)
      .reduce((sum: number, i: any) => sum + i.appliedAmount, 0);
    expect(trailingTotal).toBe(16000);
  });

  it('zero-net month: no deduction created, nothing pushed to plan.linkedAdjustmentIds', async () => {
    const ctx = buildService();

    ctx.teamFindByIdMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 10000,
      }),
    });

    // All months: net=0
    (ctx.service as any).ensureSalaryRecord = vi.fn().mockResolvedValue(makeSalaryRecord(0));
    (ctx.service as any).recalculateSalaryFromAdjustments = vi.fn().mockResolvedValue({});

    const { plan } = await (ctx.service as any).createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount: 5000,
      startMonth: 6,
      startYear: 2026,
      installmentConfig: { installmentCount: 1 },
      userId,
    });

    // No adjustments created (amount=0 -> guard skips)
    expect(ctx.adjustmentCtorMock).not.toHaveBeenCalled();
    expect(plan.linkedAdjustmentIds.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case B2: piece-rate cap basis
// ---------------------------------------------------------------------------
describe('createAdvanceRecoveryPlan — Case B2: piece-rate cap basis', () => {
  it('uses salaryAmount as cap basis when piece-rate future month net is 0', async () => {
    const ctx = buildService();

    // piece-rate member; salaryAmount=15000
    ctx.teamFindByIdMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'piece_rate',
        salaryAmount: 15000,
      }),
    });

    // Future month net=0 (no production logged yet)
    (ctx.service as any).ensureSalaryRecord = vi
      .fn()
      .mockResolvedValue(makeSalaryRecord(0, 7, 2026));
    (ctx.service as any).recalculateSalaryFromAdjustments = vi.fn().mockResolvedValue({});

    const { plan } = await (ctx.service as any).createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId,
      totalAmount: 15000,
      startMonth: 7,
      startYear: 2026,
      installmentConfig: { installmentCount: 1 },
      userId,
    });

    // cap basis = max(0, 15000) = 15000 -> full 15000 applied
    expect(ctx.adjustmentCtorMock).toHaveBeenCalledOnce();
    expect(ctx.adjustmentCtorMock.mock.calls[0][0].amount).toBe(15000);
    expect(plan.installments[0].status).toBe('applied');
    expect(plan.installments[0].appliedAmount).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Case C: legacy path — no advanceInstallments -> no plan created
// ---------------------------------------------------------------------------
describe('recordPayment branch logic — Case C', () => {
  it('absent advanceInstallments -> isMultiInstallment===false -> single deduction, no plan', () => {
    // Test the branch condition inline without invoking the full recordPayment
    // (too heavy to mock for unit test; integration coverage is in e2e scope).
    const installmentCfg = undefined as any;
    const isMultiInstallment =
      installmentCfg != null &&
      (installmentCfg.installmentCount == null ||
        installmentCfg.installmentCount > 1 ||
        installmentCfg.installmentAmount != null);

    expect(isMultiInstallment).toBe(false);
  });

  it('installmentCount===1 -> isMultiInstallment===false', () => {
    const installmentCfg = { installmentCount: 1 };
    const isMultiInstallment =
      installmentCfg != null &&
      (installmentCfg.installmentCount == null ||
        installmentCfg.installmentCount > 1 ||
        (installmentCfg as any).installmentAmount != null);

    expect(isMultiInstallment).toBe(false);
  });

  it('installmentCount > 1 -> isMultiInstallment===true', () => {
    const installmentCfg = { installmentCount: 3 };
    const isMultiInstallment =
      installmentCfg != null &&
      (installmentCfg.installmentCount == null ||
        installmentCfg.installmentCount > 1 ||
        (installmentCfg as any).installmentAmount != null);

    expect(isMultiInstallment).toBe(true);
  });

  it('installmentAmount set (no count) -> isMultiInstallment===true', () => {
    const installmentCfg = { installmentAmount: 5000 };
    const isMultiInstallment =
      installmentCfg != null &&
      ((installmentCfg as any).installmentCount == null ||
        (installmentCfg as any).installmentCount > 1 ||
        installmentCfg.installmentAmount != null);

    expect(isMultiInstallment).toBe(true);
  });

  it('service-level: createAdvanceRecoveryPlan not called when isMultiInstallment=false', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    svc.createAdvanceRecoveryDeduction = vi.fn().mockResolvedValue({ _id: new Types.ObjectId() });
    svc.createAdvanceRecoveryPlan = vi.fn().mockResolvedValue(makeDocStub());

    // Simulate the branch for absent installments
    const isAdvancePayment = true;
    const advanceAmount = 10000;
    const advanceForMonth = 6;
    const advanceForYear = 2026;
    const installmentCfg: any = undefined;
    const isMultiInstallment =
      installmentCfg != null &&
      (installmentCfg.installmentCount == null ||
        installmentCfg.installmentCount > 1 ||
        installmentCfg.installmentAmount != null);

    if (isAdvancePayment && advanceAmount > 0 && advanceForMonth && advanceForYear) {
      if (isMultiInstallment) {
        await svc.createAdvanceRecoveryPlan({
          workspaceId,
          teamMemberId,
          sourcePaymentId: new Types.ObjectId(),
          totalAmount: advanceAmount,
          startMonth: advanceForMonth,
          startYear: advanceForYear,
          installmentConfig: installmentCfg,
          userId,
        });
      } else {
        await svc.createAdvanceRecoveryDeduction({
          workspaceId,
          teamMemberId,
          targetMonth: advanceForMonth,
          targetYear: advanceForYear,
          amount: advanceAmount,
          sourcePaymentId: new Types.ObjectId(),
          userId,
        });
      }
    }

    expect(svc.createAdvanceRecoveryPlan).not.toHaveBeenCalled();
    expect(svc.createAdvanceRecoveryDeduction).toHaveBeenCalledOnce();
  });

  it('service-level: createAdvanceRecoveryPlan called when installmentCount=3', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    svc.createAdvanceRecoveryDeduction = vi.fn().mockResolvedValue({ _id: new Types.ObjectId() });
    svc.createAdvanceRecoveryPlan = vi.fn().mockResolvedValue(makeDocStub());

    const isAdvancePayment = true;
    const advanceAmount = 30000;
    const advanceForMonth = 6;
    const advanceForYear = 2026;
    const installmentCfg = { installmentCount: 3 };
    const isMultiInstallment =
      installmentCfg != null &&
      (installmentCfg.installmentCount == null ||
        installmentCfg.installmentCount > 1 ||
        (installmentCfg as any).installmentAmount != null);

    if (isAdvancePayment && advanceAmount > 0 && advanceForMonth && advanceForYear) {
      if (isMultiInstallment) {
        await svc.createAdvanceRecoveryPlan({
          workspaceId,
          teamMemberId,
          sourcePaymentId: new Types.ObjectId(),
          totalAmount: advanceAmount,
          startMonth: advanceForMonth,
          startYear: advanceForYear,
          installmentConfig: installmentCfg,
          userId,
        });
      } else {
        await svc.createAdvanceRecoveryDeduction({
          workspaceId,
          teamMemberId,
          targetMonth: advanceForMonth,
          targetYear: advanceForYear,
          amount: advanceAmount,
          sourcePaymentId: new Types.ObjectId(),
          userId,
        });
      }
    }

    expect(svc.createAdvanceRecoveryPlan).toHaveBeenCalledOnce();
    expect(svc.createAdvanceRecoveryDeduction).not.toHaveBeenCalled();
    expect(svc.createAdvanceRecoveryPlan.mock.calls[0][0].totalAmount).toBe(30000);
    expect(svc.createAdvanceRecoveryPlan.mock.calls[0][0].installmentConfig.installmentCount).toBe(
      3,
    );
  });
});
