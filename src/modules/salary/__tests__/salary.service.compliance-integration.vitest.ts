/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Slice 2 — compliance guard integration tests.
 *
 * Strategy: test the extracted private method `applyComplianceGuard` directly
 * via `(svc as any)`. This avoids having to fully orchestrate
 * `createAdvanceRecoveryPlan`'s Mongoose-heavy lifecycle (ensureSalaryRecord,
 * plan constructor, save, etc.) while still exercising the real
 * ComplianceGuardService math end-to-end.
 *
 * A real `new ComplianceGuardService()` is passed so the guard logic is not
 * mocked. AuditService is a vitest spy so we can assert override audit events.
 *
 * Cases covered:
 *   A. Compliant installment -> no throw, no override audit.
 *   B. Breach (deduction cap), overrideCompliance=false -> throws BadRequestException
 *      with code COMPLIANCE_BLOCKED.
 *   C. Breach, overrideCompliance=true, no reason -> throws 'overrideReason required'.
 *   D. Breach, overrideCompliance=true, reason supplied -> proceeds with clamped amount,
 *      calls AuditService.logEvent with action 'salary.advance_plan.compliance_override'.
 *   E. MIN_WAGE_FLOOR breach, overrideCompliance=false -> throws COMPLIANCE_BLOCKED.
 *   F. minimumWage=null -> MIN_WAGE_UNCONFIGURED warning, no breach.
 *
 * The decorator mock must be placed BEFORE SalaryService import so the
 * transitive schema @Prop/@Schema decorators are no-ops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { SalaryService } from '../salary.service';
import { ComplianceGuardService } from '../compliance-guard.service';

// ---------------------------------------------------------------------------
// Shared test IDs
// ---------------------------------------------------------------------------
const workspaceId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();
const userId = new Types.ObjectId();

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

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

function buildService() {
  const noopModel = () => ({
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    updateMany: vi.fn(),
  });

  const adjustmentCtorMock = vi.fn().mockImplementation(() => ({
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));
  (adjustmentCtorMock as any).find = vi.fn().mockResolvedValue([]);
  (adjustmentCtorMock as any).findOne = vi.fn().mockResolvedValue(null);
  (adjustmentCtorMock as any).findById = vi.fn().mockResolvedValue(null);
  (adjustmentCtorMock as any).updateMany = vi.fn().mockResolvedValue({});

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

  const teamModelMock = {
    findById: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };
  const callerScope = {
    resolve: vi.fn(),
    effectiveScope: vi.fn(),
    selfFilterValue: vi.fn(),
  };

  // Use a real ComplianceGuardService so the math is exercised end-to-end.
  const complianceGuard = new ComplianceGuardService();

  const service = new SalaryService(
    noopModel() as any, // salaryModel
    noopModel() as any, // paymentModel
    teamModelMock as any, // teamModel
    noopModel() as any, // attendanceModel
    noopModel() as any, // incrementModel
    adjustmentCtorMock as any, // salaryAdjustmentModel
    noopModel() as any, // payrollConfigModel
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
    complianceGuard, // complianceGuard
  );

  return { service, auditService, complianceGuard };
}

// ---------------------------------------------------------------------------
// Shared guard-call params builder
// ---------------------------------------------------------------------------
function makeGuardParams(overrides: Partial<Parameters<any>[0]> = {}) {
  const pendingBreaches: any[] = [];
  const collectedWarnings: any[] = [];
  return {
    workspaceId,
    teamMemberId,
    userId,
    month: 6,
    year: 2026,
    totalAdvanceAmount: 60000,
    proposedInstallment: 5000,
    currentTotalDeductions: 0,
    grossSalaryForMonth: 20000,
    netSalaryBeforeRecovery: 20000,
    minimumWageMonthly: null,
    deductionCapPercent: 50,
    overrideCompliance: false,
    overrideReason: undefined as string | undefined,
    pendingBreaches,
    collectedWarnings,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Case A: Compliant installment
// ---------------------------------------------------------------------------
describe('applyComplianceGuard — Case A: compliant installment', () => {
  it('returns proposedInstallment unchanged and emits no audit event', async () => {
    const { service, auditService } = buildService();
    const svc = service as any;

    const params = makeGuardParams({
      proposedInstallment: 5000,
      grossSalaryForMonth: 20000,
      netSalaryBeforeRecovery: 20000,
      minimumWageMonthly: 8000,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
    });

    // 5000 <= 20000 * 50% = 10000 (cap ok)
    // net after = 20000 - 5000 = 15000 >= 8000 (floor ok)
    const result = await svc.applyComplianceGuard(params);

    expect(result.allowed).toBe(5000);
    expect(params.pendingBreaches).toHaveLength(0);
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  it('emits MIN_WAGE_UNCONFIGURED warning when minimumWageMonthly is null', async () => {
    const { service } = buildService();
    const svc = service as any;

    const params = makeGuardParams({
      proposedInstallment: 5000,
      grossSalaryForMonth: 20000,
      netSalaryBeforeRecovery: 20000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
    });

    await svc.applyComplianceGuard(params);

    expect(params.collectedWarnings).toHaveLength(1);
    expect(params.collectedWarnings[0].code).toBe('MIN_WAGE_UNCONFIGURED');
    expect(params.pendingBreaches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case B: Deduction cap breach, overrideCompliance=false
// ---------------------------------------------------------------------------
describe('applyComplianceGuard — Case B: DEDUCTION_CAP breach, no override', () => {
  it('pushes breach to pendingBreaches (does not throw directly)', async () => {
    const { service, auditService } = buildService();
    const svc = service as any;

    // gross=10000, cap=50% -> ceiling=5000
    // proposed=7000, existing=0 -> total=7000 > 5000 -> BREACH
    const params = makeGuardParams({
      proposedInstallment: 7000,
      grossSalaryForMonth: 10000,
      netSalaryBeforeRecovery: 10000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: false,
    });

    await svc.applyComplianceGuard(params);

    expect(params.pendingBreaches).toHaveLength(1);
    expect(params.pendingBreaches[0].code).toBe('DEDUCTION_CAP');
    expect(params.pendingBreaches[0].month).toBe(6);
    expect(params.pendingBreaches[0].year).toBe(2026);
    expect(params.pendingBreaches[0].proposed).toBe(7000);
    expect(params.pendingBreaches[0].maxCompliant).toBe(5000);
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  it('createAdvanceRecoveryPlan throws BadRequestException with COMPLIANCE_BLOCKED when pendingBreaches exist', async () => {
    const { service, auditService } = buildService();
    const svc = service as any;

    // Mock member query: monthly, salaryAmount=10000
    svc.teamModel.findById = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 10000,
        minimumWageMonthlyOverride: null,
      }),
    });

    // Mock payrollConfigModel (getPayrollConfig calls findOneAndUpdate)
    svc.payrollConfigModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          compliance: {
            minimumWageMonthly: null,
            deductionCapPercent: 50,
            installmentAdvisoryMaxMonths: 12,
          },
          features: { advancePayments: true },
        }),
      }),
    };

    // ensureSalaryRecord: baseSalary=10000, net=10000, existing deductions=0.
    // With 50% cap, ceiling = 10000 * 50% = 5000. Planned installment = 60000/3 = 20000 > 5000 -> BREACH.
    svc.ensureSalaryRecord = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      baseSalary: 10000,
      additions: 0,
      netSalary: 10000,
      deductions: 0,
      isLocked: false,
      month: 6,
      year: 2026,
    });

    // Stub createAdvanceRecoveryDeduction to avoid the aggregate dependency
    // in recalculateSalaryFromAdjustments. The compliance guard is what we're
    // testing - the deduction creation path is covered by advance-plan tests.
    svc.createAdvanceRecoveryDeduction = vi
      .fn()
      .mockResolvedValue({ _id: new Types.ObjectId(), save: vi.fn() });

    // planned installment = 60000 / 3 = 20000, which breaches 50% of 10000 (5000 cap)
    await expect(
      svc.createAdvanceRecoveryPlan({
        workspaceId,
        teamMemberId,
        sourcePaymentId: new Types.ObjectId(),
        totalAmount: 60000,
        startMonth: 6,
        startYear: 2026,
        installmentConfig: { installmentCount: 3 },
        userId,
        overrideCompliance: false,
        overrideReason: undefined,
      }),
    ).rejects.toThrow(BadRequestException);

    // Audit for plan creation should NOT have been called (thrown before save).
    const planCreatedCalls = auditService.logEvent.mock.calls.filter(
      (c: any[]) => c[0]?.action === 'salary.advance_plan.created',
    );
    expect(planCreatedCalls).toHaveLength(0);

    // REGRESSION GUARD: no deduction must be written when the plan is blocked.
    // This is the key invariant of the two-pass redesign: persistence only
    // happens in pass 2, which is never reached when pendingBreaches causes a throw.
    expect(svc.createAdvanceRecoveryDeduction).not.toHaveBeenCalled();
  });

  it('thrown BadRequestException body has code COMPLIANCE_BLOCKED', async () => {
    const { service } = buildService();
    const svc = service as any;

    svc.teamModel.findById = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 10000,
        minimumWageMonthlyOverride: null,
      }),
    });
    svc.payrollConfigModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          compliance: {
            minimumWageMonthly: null,
            deductionCapPercent: 50,
            installmentAdvisoryMaxMonths: 12,
          },
          features: {},
        }),
      }),
    };
    svc.ensureSalaryRecord = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      baseSalary: 10000,
      additions: 0,
      netSalary: 10000,
      deductions: 0,
      isLocked: false,
      month: 6,
      year: 2026,
    });
    svc.createAdvanceRecoveryDeduction = vi
      .fn()
      .mockResolvedValue({ _id: new Types.ObjectId(), save: vi.fn() });

    let caught: any;
    try {
      await svc.createAdvanceRecoveryPlan({
        workspaceId,
        teamMemberId,
        sourcePaymentId: new Types.ObjectId(),
        totalAmount: 60000,
        startMonth: 6,
        startYear: 2026,
        installmentConfig: { installmentCount: 3 },
        userId,
        overrideCompliance: false,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const body = caught.getResponse();
    expect(body.code).toBe('COMPLIANCE_BLOCKED');
    expect(Array.isArray(body.breaches)).toBe(true);
    expect(body.breaches.length).toBeGreaterThan(0);
    expect(body.breaches[0].code).toBe('DEDUCTION_CAP');
  });
});

// ---------------------------------------------------------------------------
// Case C: override=true but missing reason
// ---------------------------------------------------------------------------
describe('applyComplianceGuard — Case C: override=true, no reason', () => {
  it('throws BadRequestException about overrideReason', async () => {
    const { service } = buildService();
    const svc = service as any;

    // gross=10000, proposed=7000 -> DEDUCTION_CAP breach
    const params = makeGuardParams({
      proposedInstallment: 7000,
      grossSalaryForMonth: 10000,
      netSalaryBeforeRecovery: 10000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: true,
      overrideReason: undefined,
    });

    await expect(svc.applyComplianceGuard(params)).rejects.toThrow(
      'overrideReason is required when overrideCompliance is true.',
    );
  });

  it('also throws when overrideReason is blank string', async () => {
    const { service } = buildService();
    const svc = service as any;

    const params = makeGuardParams({
      proposedInstallment: 7000,
      grossSalaryForMonth: 10000,
      netSalaryBeforeRecovery: 10000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: true,
      overrideReason: '   ',
    });

    await expect(svc.applyComplianceGuard(params)).rejects.toThrow(
      'overrideReason is required when overrideCompliance is true.',
    );
  });
});

// ---------------------------------------------------------------------------
// Case D: override=true with reason -> clamped amount + audit event
// ---------------------------------------------------------------------------
describe('applyComplianceGuard — Case D: override=true with reason', () => {
  let ctx: ReturnType<typeof buildService>;

  beforeEach(() => {
    ctx = buildService();
  });

  it('returns clamped allowedInstallment (not original proposed)', async () => {
    const svc = ctx.service as any;

    // gross=10000, cap=50% -> max=5000; proposed=7000 -> BREACH; allowed=5000
    const params = makeGuardParams({
      proposedInstallment: 7000,
      grossSalaryForMonth: 10000,
      netSalaryBeforeRecovery: 10000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: true,
      overrideReason: 'Owner confirmed legal authorization for this deduction.',
    });

    const result = await svc.applyComplianceGuard(params);

    expect(result.allowed).toBe(5000);
    expect(params.pendingBreaches).toHaveLength(0); // override path does not populate pendingBreaches
  });

  it('calls AuditService.logEvent with action salary.advance_plan.compliance_override', async () => {
    const svc = ctx.service as any;

    const params = makeGuardParams({
      proposedInstallment: 7000,
      grossSalaryForMonth: 10000,
      netSalaryBeforeRecovery: 10000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: true,
      overrideReason: 'Owner confirmed legal authorization for this deduction.',
    });

    await svc.applyComplianceGuard(params);

    expect(ctx.auditService.logEvent).toHaveBeenCalledOnce();
    const call = ctx.auditService.logEvent.mock.calls[0][0];
    expect(call.action).toBe('salary.advance_plan.compliance_override');
    expect(call.before).toEqual({ proposed: 7000 });
    expect(call.after).toEqual({ applied: 5000 });
    expect(call.meta.overrideReason).toBe(
      'Owner confirmed legal authorization for this deduction.',
    );
    // breachCodes is now a string array (not a joined string).
    expect(Array.isArray(call.meta.breachCodes)).toBe(true);
    expect(call.meta.breachCodes).toContain('DEDUCTION_CAP');
    expect(call.workspaceId).toBe(workspaceId);
  });

  it('integration: createAdvanceRecoveryPlan uses clamped amount when override=true', async () => {
    const svc = ctx.service as any;

    svc.teamModel.findById = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 10000,
        minimumWageMonthlyOverride: null,
      }),
    });
    svc.payrollConfigModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          compliance: {
            minimumWageMonthly: null,
            deductionCapPercent: 50,
            installmentAdvisoryMaxMonths: 12,
          },
          features: {},
        }),
      }),
    };
    // baseSalary=10000, net=10000, deductions=0 -> cap ceiling = 10000 * 50% = 5000
    svc.ensureSalaryRecord = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      baseSalary: 10000,
      additions: 0,
      netSalary: 10000,
      deductions: 0,
      isLocked: false,
      month: 6,
      year: 2026,
    });
    // Stub deduction creation to avoid salaryAdjustmentModel.aggregate dep.
    svc.createAdvanceRecoveryDeduction = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      save: vi.fn(),
    });

    // proposed = 60000 / 3 = 20000 per month, but cap = 5000 -> override to 5000
    const { plan } = await svc.createAdvanceRecoveryPlan({
      workspaceId,
      teamMemberId,
      sourcePaymentId: new Types.ObjectId(),
      totalAmount: 60000,
      startMonth: 6,
      startYear: 2026,
      installmentConfig: { installmentCount: 3 },
      userId,
      overrideCompliance: true,
      overrideReason: 'Legal authorization confirmed.',
    });

    // Each applied amount must be exactly 5000: the compliance-clamped value.
    // gross=10000, cap=50% -> ceiling=5000; proposed=20000 -> clamped to 5000.
    // availableNet=10000 >= 5000, so min(5000, 10000) = exactly 5000.
    const appliedAmounts = plan.installments.map((i: any) => i.appliedAmount);
    for (const amt of appliedAmounts) {
      expect(amt).toBe(5000);
    }

    // Override audit events were fired (one per installment that breached)
    const overrideCalls = ctx.auditService.logEvent.mock.calls.filter(
      (c: any[]) => c[0]?.action === 'salary.advance_plan.compliance_override',
    );
    expect(overrideCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Case E: MIN_WAGE_FLOOR breach, overrideCompliance=false
// ---------------------------------------------------------------------------
describe('applyComplianceGuard — Case E: MIN_WAGE_FLOOR breach, no override', () => {
  it('pushes MIN_WAGE_FLOOR to pendingBreaches', async () => {
    const { service } = buildService();
    const svc = service as any;

    // net=12000, minimumWage=10000, proposed=5000 -> net after = 12000 - 5000 = 7000 < 10000
    const params = makeGuardParams({
      proposedInstallment: 5000,
      grossSalaryForMonth: 20000,
      netSalaryBeforeRecovery: 12000,
      minimumWageMonthly: 10000,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: false,
    });

    await svc.applyComplianceGuard(params);

    expect(params.pendingBreaches).toHaveLength(1);
    expect(params.pendingBreaches[0].code).toBe('MIN_WAGE_FLOOR');
    // maxCompliant = 12000 - 10000 = 2000
    expect(params.pendingBreaches[0].maxCompliant).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Case F: minimumWage=null -> soft warning, no breach
// ---------------------------------------------------------------------------
describe('applyComplianceGuard — Case F: unconfigured minimum wage', () => {
  it('emits MIN_WAGE_UNCONFIGURED warning and returns full proposed amount', async () => {
    const { service } = buildService();
    const svc = service as any;

    const params = makeGuardParams({
      proposedInstallment: 3000,
      grossSalaryForMonth: 20000,
      netSalaryBeforeRecovery: 20000,
      minimumWageMonthly: null,
      deductionCapPercent: 50,
      currentTotalDeductions: 0,
      overrideCompliance: false,
    });

    const result = await svc.applyComplianceGuard(params);

    expect(result.allowed).toBe(3000);
    expect(params.pendingBreaches).toHaveLength(0);
    expect(params.collectedWarnings.some((w: any) => w.code === 'MIN_WAGE_UNCONFIGURED')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Case G: MIN_WAGE_FLOOR breach -> createAdvanceRecoveryPlan throws + zero deductions
//
// Regression guard for the two-pass fix: ensures that when a MIN_WAGE_FLOOR
// breach causes a block, NO SalaryAdjustment documents are written before the
// throw. This is the integration-level counterpart to Case B's unit guard.
//
// Setup: minimumWageMonthly=10000, baseSalary=12000, net=12000, deductions=0.
// Proposed installment = 60000/3 = 20000.
// net after deduction = 12000 - 20000 < 0 -> also breaches DEDUCTION_CAP (50%).
// Either way, pendingBreaches.length > 0 -> COMPLIANCE_BLOCKED throw before pass 2.
// ---------------------------------------------------------------------------
describe('createAdvanceRecoveryPlan — Case G: MIN_WAGE_FLOOR breach -> zero deductions on block', () => {
  it('throws COMPLIANCE_BLOCKED and never calls createAdvanceRecoveryDeduction', async () => {
    const { service } = buildService();
    const svc = service as any;

    svc.teamModel.findById = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: teamMemberId,
        salaryType: 'monthly',
        salaryAmount: 12000,
        minimumWageMonthlyOverride: null,
      }),
    });

    svc.payrollConfigModel = {
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          compliance: {
            // minimumWageMonthly set: 10000
            minimumWageMonthly: 10000,
            deductionCapPercent: 50,
            installmentAdvisoryMaxMonths: 12,
          },
          features: {},
        }),
      }),
    };

    // baseSalary=12000, net=12000, deductions=0.
    // installment = 60000/3 = 20000.
    // DEDUCTION_CAP: 20000 > 12000*50%=6000 -> breach.
    // MIN_WAGE_FLOOR: net 12000 - 20000 < 10000 -> breach.
    // Both breach, overrideCompliance=false -> throws COMPLIANCE_BLOCKED.
    svc.ensureSalaryRecord = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      baseSalary: 12000,
      additions: 0,
      netSalary: 12000,
      deductions: 0,
      isLocked: false,
      month: 6,
      year: 2026,
    });

    const createDeductionSpy = vi.fn().mockResolvedValue({ _id: new Types.ObjectId() });
    svc.createAdvanceRecoveryDeduction = createDeductionSpy;

    let caught: any;
    try {
      await svc.createAdvanceRecoveryPlan({
        workspaceId,
        teamMemberId,
        sourcePaymentId: new Types.ObjectId(),
        totalAmount: 60000,
        startMonth: 6,
        startYear: 2026,
        installmentConfig: { installmentCount: 3 },
        userId,
        overrideCompliance: false,
        overrideReason: undefined,
      });
    } catch (e) {
      caught = e;
    }

    // Structured throw.
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = caught.getResponse();
    expect(body.code).toBe('COMPLIANCE_BLOCKED');
    expect(Array.isArray(body.breaches)).toBe(true);
    expect(body.breaches.length).toBeGreaterThan(0);

    // Key two-pass invariant: no deductions written before the throw.
    expect(createDeductionSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Note on carry/trailing-month breach test
//
// The carry loop (pass 1b) shares the same pendingBreaches array and the same
// gate (throw before pass 2), so a carry-month breach is architecturally
// identical to a primary-month breach for the zero-deduction invariant.
//
// Triggering a carry breach in isolation requires: (a) a primary month where
// net < plannedInstallment (cap-and-carry fires, shortfall > 0), and
// (b) the carry month having a net that breaches compliance for the shortfall.
// Simulating both conditions via ensureSalaryRecord mocks would require
// call-order-sensitive mock sequences that are brittle and do not add signal
// beyond Case G above. Skipped; covered architecturally by the shared gate.
// ---------------------------------------------------------------------------
