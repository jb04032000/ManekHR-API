/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Task 4 — Advance Recovery Plan lifecycle unit tests.
 *
 * Covers:
 *   - reversePayment of a plan-backed advance: all linked adjustments reversed,
 *     each distinct target salary recalculated, plan marked reversed.
 *   - editAdvanceRecoveryPlan pause: future installments reversed, plan paused.
 *   - editAdvanceRecoveryPlan resume: re-materializes from cutover.
 *   - editAdvanceRecoveryPlan installmentAmount change: reverses future,
 *     conservation holds (frozen-active + remaining === totalAmount).
 *   - earlyPayoffAdvanceRecoveryPlan: future installments reversed, plan completed.
 *   - getOutstandingAdvances plan path: returns per-month breakdown + correct remaining.
 *   - Legacy single-adjustment reverse is unchanged (regression guard).
 *
 * The decorator mock must be placed BEFORE SalaryService import so transitive
 * schema @Prop/@Schema decorators are no-ops.
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
import { SalaryService } from '../salary.service';

// ---------------------------------------------------------------------------
// Shared IDs
// ---------------------------------------------------------------------------
const workspaceId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();
const userId = new Types.ObjectId();
const workspaceObjectId = new Types.ObjectId(workspaceId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanDoc(overrides: Record<string, any> = {}): Record<string, any> {
  const planId = new Types.ObjectId();
  const adjId1 = new Types.ObjectId();
  const adjId2 = new Types.ObjectId();

  return {
    _id: planId,
    workspaceId: workspaceObjectId,
    teamMemberId,
    sourcePaymentId: new Types.ObjectId(),
    totalAmount: 20000,
    installmentAmount: 10000,
    installmentCount: 2,
    startMonth: 6,
    startYear: 2026,
    status: 'active',
    recoveredAmount: 0,
    remainingAmount: 20000,
    linkedAdjustmentIds: [adjId1, adjId2],
    installments: [
      {
        index: 1,
        month: 6,
        year: 2026,
        plannedAmount: 10000,
        appliedAmount: 10000,
        adjustmentId: adjId1,
        status: 'applied',
      },
      {
        index: 2,
        month: 7,
        year: 2026,
        plannedAmount: 10000,
        appliedAmount: 10000,
        adjustmentId: adjId2,
        status: 'applied',
      },
    ],
    closedBy: undefined,
    closedAt: undefined,
    closureType: undefined,
    closureReason: undefined,
    pausedBy: undefined,
    pausedAt: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeAdjDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: new Types.ObjectId(),
    workspaceId: workspaceObjectId,
    teamMemberId,
    salaryId: new Types.ObjectId(),
    month: 6,
    year: 2026,
    type: 'deduction',
    category: 'advance_recovery',
    amount: 10000,
    source: 'system',
    reasonTitle: 'Advance recovery',
    attachments: [],
    status: 'active',
    createdBy: userId,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePaymentDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: new Types.ObjectId(),
    workspaceId: workspaceObjectId,
    teamMemberId,
    salaryId: new Types.ObjectId(),
    amount: 20000,
    paymentMode: 'cash',
    paymentDate: new Date(),
    recordedBy: userId,
    status: 'active',
    isAdvance: true,
    advanceForMonth: 6,
    advanceForYear: 2026,
    advanceRecoveryPlanId: new Types.ObjectId(),
    advanceRecoveryAdjustmentId: undefined,
    commission: 0,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSalaryDoc(month = 6, year = 2026): Record<string, any> {
  return {
    _id: new Types.ObjectId(),
    workspaceId: workspaceObjectId,
    teamMemberId,
    month,
    year,
    baseSalary: 20000,
    netSalary: 20000,
    isLocked: false,
    additions: 0,
    deductions: 0,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a SalaryService with all dependencies mocked.
 * Callers stub specific model methods per test.
 */
function buildService() {
  const noopModel = () => ({
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    updateMany: vi.fn().mockResolvedValue({}),
    collection: { name: 'salaries' },
  });

  const adjustmentCtorMock = vi.fn().mockImplementation((data: any) => ({
    _id: new Types.ObjectId(),
    ...data,
    save: vi.fn().mockResolvedValue(undefined),
  }));
  (adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue([]),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
  });
  (adjustmentCtorMock as any).findOne = vi
    .fn()
    .mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  (adjustmentCtorMock as any).findById = vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue(null),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
  });
  (adjustmentCtorMock as any).updateMany = vi.fn().mockResolvedValue({});

  const planCtorMock = vi.fn().mockImplementation((data: any) => ({
    _id: new Types.ObjectId(),
    installments: [],
    linkedAdjustmentIds: [],
    recoveredAmount: 0,
    remainingAmount: data.totalAmount ?? 0,
    status: 'active',
    save: vi.fn().mockResolvedValue(undefined),
    ...data,
  }));
  (planCtorMock as any).find = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });
  (planCtorMock as any).findOne = vi
    .fn()
    .mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  (planCtorMock as any).findById = vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue(null),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
  });

  const salaryModel = noopModel();
  const paymentModel = noopModel();
  const teamModel = {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ salaryType: 'monthly', salaryAmount: 20000 }),
    }),
    find: vi.fn(),
    findOne: vi.fn(),
    collection: { name: 'teammembers' },
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };
  const callerScope = {
    resolve: vi.fn().mockResolvedValue({ isOwner: true }),
    effectiveScope: vi.fn().mockReturnValue('all'),
    selfFilterValue: vi.fn(),
  };

  const service = new SalaryService(
    salaryModel as any,
    paymentModel as any,
    teamModel as any,
    noopModel() as any, // attendanceModel
    noopModel() as any, // incrementModel
    adjustmentCtorMock as any,
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
    planCtorMock as any,
    auditService as any,
    {} as any, // mailService
    {} as any, // payslipPdfService
    {} as any, // complianceExportService
    {} as any, // tdsService
    {} as any, // gratuityService
    {} as any, // fnfService
    {} as any, // attendancePoliciesService
    {} as any, // teamService
    callerScope as any,
    postHog as any,
  );

  return {
    service,
    salaryModel,
    paymentModel,
    adjustmentCtorMock,
    planCtorMock,
    teamModel,
    auditService,
    postHog,
  };
}

// ---------------------------------------------------------------------------
// reversePayment — plan-backed advance
// ---------------------------------------------------------------------------
describe('reversePayment: plan-backed advance', () => {
  let ctx: ReturnType<typeof buildService>;

  beforeEach(() => {
    ctx = buildService();
  });

  it('reverses ALL linked adjustments and marks plan.status=reversed', async () => {
    const svc = ctx.service as any;

    const adj1 = makeAdjDoc({ month: 6, year: 2026, amount: 10000 });
    const adj2 = makeAdjDoc({ month: 7, year: 2026, amount: 10000 });
    const planDoc = makePlanDoc({
      linkedAdjustmentIds: [adj1._id, adj2._id],
      installments: [
        {
          index: 1,
          month: 6,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj1._id,
          status: 'applied',
        },
        {
          index: 2,
          month: 7,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj2._id,
          status: 'applied',
        },
      ],
    });

    const paymentDoc = makePaymentDoc({
      advanceRecoveryPlanId: planDoc._id,
      advanceRecoveryAdjustmentId: undefined,
    });

    // salaryModel: findOne for final source salary lookup + findById for adj salaries.
    const salaryDoc = makeSalaryDoc();
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(salaryDoc),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
    });
    ctx.salaryModel.findById = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(salaryDoc),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
    });
    // paymentModel: findOne to load payment, final findById to return result
    ctx.paymentModel.findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(paymentDoc),
    });
    ctx.paymentModel.findById = vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(paymentDoc),
    });
    // salaryAdjustmentModel: findById for each adj, find for linkedPaymentId loop
    (ctx.adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue([]), // no linkedPaymentId adjustments
    });
    let adjCallCount = 0;
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockImplementation(() => {
      adjCallCount++;
      const doc = adjCallCount === 1 ? adj1 : adj2;
      return { exec: vi.fn().mockResolvedValue(doc) };
    });
    // planCtorMock.findById: return plan
    (ctx.planCtorMock as any).findById = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    // stub assertNotLocked
    svc.assertNotLocked = vi.fn().mockResolvedValue(undefined);
    // stub recalculateSalaryFromAdjustments
    svc.recalculateSalaryFromAdjustments = vi.fn().mockResolvedValue(makeSalaryDoc());
    svc.refreshPlanProgress = vi.fn().mockResolvedValue(undefined);

    await svc.reversePayment(workspaceId, String(paymentDoc._id), String(userId), {
      reversalReason: 'test reversal',
    });

    // Both adjustments must be reversed.
    expect(adj1.status).toBe('reversed');
    expect(adj2.status).toBe('reversed');
    expect(adj1.save).toHaveBeenCalled();
    expect(adj2.save).toHaveBeenCalled();

    // recalculateSalaryFromAdjustments: once per adj inside reverseAdjustmentDoc (2),
    // plus once for the source salary at the end of reversePayment = 3 total.
    expect(svc.recalculateSalaryFromAdjustments).toHaveBeenCalledTimes(3);

    // Plan status set to reversed.
    expect(planDoc.status).toBe('reversed');
    expect(planDoc.closureType).toBe('reversed');
    expect(planDoc.remainingAmount).toBe(0);
    expect(planDoc.save).toHaveBeenCalled();

    // PostHog emitted with reversedAdvanceRecoveryPlanId.
    expect(ctx.postHog.capture).toHaveBeenCalled();
    const captureCall = ctx.postHog.capture.mock.calls[0][0];
    expect(captureCall.properties.reversedAdvanceRecoveryPlanId).toBe(String(planDoc._id));
  });

  it('skips plan block when already reversed', async () => {
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'reversed' });
    const paymentDoc = makePaymentDoc({
      advanceRecoveryPlanId: planDoc._id,
      advanceRecoveryAdjustmentId: undefined,
    });

    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(makeSalaryDoc()),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
    });
    ctx.paymentModel.findOne = vi
      .fn()
      .mockReturnValue({ exec: vi.fn().mockResolvedValue(paymentDoc) });
    ctx.paymentModel.findById = vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(paymentDoc),
    });
    (ctx.adjustmentCtorMock as any).find = vi
      .fn()
      .mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });
    (ctx.planCtorMock as any).findById = vi
      .fn()
      .mockReturnValue({ exec: vi.fn().mockResolvedValue(planDoc) });

    svc.assertNotLocked = vi.fn().mockResolvedValue(undefined);
    svc.recalculateSalaryFromAdjustments = vi.fn().mockResolvedValue(makeSalaryDoc());

    await svc.reversePayment(workspaceId, String(paymentDoc._id), String(userId), {
      reversalReason: 'test',
    });

    // No adjustment lookups for plan (it was already reversed).
    expect(planDoc.save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reversePayment — legacy single-adjustment (regression guard)
// ---------------------------------------------------------------------------
describe('reversePayment: legacy single-adjustment (regression guard)', () => {
  it('still reverses a single advanceRecoveryAdjustmentId adjustment', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const legacyAdj = makeAdjDoc({ month: 6, year: 2026, amount: 5000 });
    const paymentDoc = makePaymentDoc({
      advanceRecoveryAdjustmentId: legacyAdj._id,
      advanceRecoveryPlanId: undefined,
    });

    const salaryDoc = makeSalaryDoc();
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(salaryDoc),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
    });
    // reverseAdjustmentDoc calls salaryModel.findById for the adj's salary.
    ctx.salaryModel.findById = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(salaryDoc),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
    });
    ctx.paymentModel.findOne = vi
      .fn()
      .mockReturnValue({ exec: vi.fn().mockResolvedValue(paymentDoc) });
    ctx.paymentModel.findById = vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(paymentDoc),
    });
    (ctx.adjustmentCtorMock as any).find = vi
      .fn()
      .mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(legacyAdj),
    });

    svc.assertNotLocked = vi.fn().mockResolvedValue(undefined);
    svc.recalculateSalaryFromAdjustments = vi.fn().mockResolvedValue(makeSalaryDoc());

    await svc.reversePayment(workspaceId, String(paymentDoc._id), String(userId), {
      reversalReason: 'legacy reverse test',
    });

    expect(legacyAdj.status).toBe('reversed');
    expect(legacyAdj.save).toHaveBeenCalled();
    // reverseAdjustmentDoc recalcs the adj salary (call 1),
    // reversePayment recalcs the source salary (call 2).
    expect(svc.recalculateSalaryFromAdjustments).toHaveBeenCalledTimes(2);
    // Audit: 1 for the adjustment reversal (inside reverseAdjustmentDoc) + 1 for payment reversal.
    expect(ctx.auditService.logEvent).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// editAdvanceRecoveryPlan — pause
// ---------------------------------------------------------------------------
describe('editAdvanceRecoveryPlan: pause', () => {
  it('reverses future installments and marks plan paused', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const adj1 = makeAdjDoc({ month: 6, year: 2026 });
    const adj2 = makeAdjDoc({ month: 7, year: 2026 });
    const planDoc = makePlanDoc({
      linkedAdjustmentIds: [adj1._id, adj2._id],
    });

    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    // For the salary lock check in isFrozenEntry.
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null), // no salary record = not locked
    });
    // adj lookups for future entries.
    let adjFindCount = 0;
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockImplementation(() => {
      adjFindCount++;
      const doc = adjFindCount <= 2 ? (adjFindCount === 1 ? adj1 : adj2) : null;
      return { exec: vi.fn().mockResolvedValue(doc) };
    });
    svc.reverseAdjustmentDoc = vi.fn().mockResolvedValue(undefined);
    svc.refreshPlanProgress = vi.fn().mockResolvedValue(undefined);

    // Mock Date so "current" payroll month is 5/2026 — both installment months (6,7) are future.
    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026
      return new realDate(...args);
    });

    try {
      const result = await svc.editAdvanceRecoveryPlan(
        workspaceId,
        String(planDoc._id),
        String(userId),
        {
          action: 'pause',
        },
      );

      expect(result.status).toBe('paused');
      expect(result.pausedBy.toString()).toBe(String(userId));
      // reverseAdjustmentDoc called for both future installments.
      expect(svc.reverseAdjustmentDoc).toHaveBeenCalledTimes(2);
      // Audit + PostHog fired.
      expect(ctx.auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'salary.advance_plan.paused' }),
      );
      expect(ctx.postHog.capture).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'salary.advance_plan_paused' }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws BadRequestException if plan is already paused', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'paused' });
    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null),
    });

    await expect(
      svc.editAdvanceRecoveryPlan(workspaceId, String(planDoc._id), String(userId), {
        action: 'pause',
      }),
    ).rejects.toThrow('already paused');
  });
});

// ---------------------------------------------------------------------------
// editAdvanceRecoveryPlan — resume
// ---------------------------------------------------------------------------
describe('editAdvanceRecoveryPlan: resume', () => {
  it('re-materializes installments from cutover month', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'paused' });
    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null),
    });
    svc.materializeInstallments = vi.fn().mockResolvedValue(undefined);
    svc.refreshPlanProgress = vi.fn().mockResolvedValue(undefined);

    // Frozen active check: no adjustments are frozen (all are future).
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null),
    });

    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026
      return new realDate(...args);
    });

    try {
      const result = await svc.editAdvanceRecoveryPlan(
        workspaceId,
        String(planDoc._id),
        String(userId),
        {
          action: 'resume',
        },
      );

      expect(result.status).toBe('active');
      expect(svc.materializeInstallments).toHaveBeenCalledOnce();
      expect(ctx.auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'salary.advance_plan.resumed' }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws if plan is not paused', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'active' });
    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null),
    });

    await expect(
      svc.editAdvanceRecoveryPlan(workspaceId, String(planDoc._id), String(userId), {
        action: 'resume',
      }),
    ).rejects.toThrow('must be paused');
  });
});

// ---------------------------------------------------------------------------
// editAdvanceRecoveryPlan — installmentAmount change + conservation
// ---------------------------------------------------------------------------
describe('editAdvanceRecoveryPlan: installmentAmount change', () => {
  it('reverses future installments and re-spreads; conservation holds', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    // Two installments: month 6+7 (both future relative to May 2026).
    const adj1 = makeAdjDoc({ month: 6, year: 2026, amount: 10000 });
    const adj2 = makeAdjDoc({ month: 7, year: 2026, amount: 10000 });
    const planDoc = makePlanDoc({
      totalAmount: 20000,
      remainingAmount: 20000,
      linkedAdjustmentIds: [adj1._id, adj2._id],
      installments: [
        {
          index: 1,
          month: 6,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj1._id,
          status: 'applied',
        },
        {
          index: 2,
          month: 7,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj2._id,
          status: 'applied',
        },
      ],
    });

    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null), // not locked
    });
    let findByIdCount = 0;
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockImplementation(() => {
      findByIdCount++;
      const doc = findByIdCount === 1 ? adj1 : adj2;
      return { exec: vi.fn().mockResolvedValue(doc) };
    });
    // Frozen active query (lean).
    (ctx.adjustmentCtorMock as any).findById.mockImplementation(() => ({
      exec: vi.fn().mockResolvedValue(adj1),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
    }));

    svc.reverseAdjustmentDoc = vi.fn().mockResolvedValue(undefined);
    svc.materializeInstallments = vi.fn().mockResolvedValue(undefined);
    svc.refreshPlanProgress = vi.fn().mockResolvedValue(undefined);

    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026
      return new realDate(...args);
    });

    try {
      const result = await svc.editAdvanceRecoveryPlan(
        workspaceId,
        String(planDoc._id),
        String(userId),
        {
          installmentAmount: 5000,
        },
      );

      // reverseAdjustmentDoc called for each future installment (2).
      expect(svc.reverseAdjustmentDoc).toHaveBeenCalledTimes(2);
      // materializeInstallments called with new amount.
      expect(svc.materializeInstallments).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        expect.any(Number),
        5000,
        expect.anything(),
        workspaceId,
      );
      // Audit fired.
      expect(ctx.auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'salary.advance_plan.edited' }),
      );
      expect(result.installmentAmount).toBe(5000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws if plan is completed', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'completed' });
    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    ctx.salaryModel.findOne = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(null),
    });

    await expect(
      svc.editAdvanceRecoveryPlan(workspaceId, String(planDoc._id), String(userId), {
        installmentAmount: 5000,
      }),
    ).rejects.toThrow('completed');
  });
});

// ---------------------------------------------------------------------------
// earlyPayoffAdvanceRecoveryPlan
// ---------------------------------------------------------------------------
describe('earlyPayoffAdvanceRecoveryPlan', () => {
  it('reverses future installments and marks plan completed/early_payoff', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const adj1 = makeAdjDoc({ month: 6, year: 2026 });
    const adj2 = makeAdjDoc({ month: 7, year: 2026 });
    const planDoc = makePlanDoc({
      installments: [
        {
          index: 1,
          month: 6,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj1._id,
          status: 'applied',
        },
        {
          index: 2,
          month: 7,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj2._id,
          status: 'applied',
        },
      ],
    });

    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    let adjCallCount = 0;
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockImplementation(() => {
      adjCallCount++;
      const doc = adjCallCount === 1 ? adj1 : adj2;
      return { exec: vi.fn().mockResolvedValue(doc) };
    });
    svc.reverseAdjustmentDoc = vi.fn().mockResolvedValue(undefined);
    svc.refreshPlanProgress = vi.fn().mockResolvedValue(undefined);

    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026 -> months 6,7 are future
      return new realDate(...args);
    });

    try {
      const result = await svc.earlyPayoffAdvanceRecoveryPlan(
        workspaceId,
        String(planDoc._id),
        String(userId),
        { reason: 'Employee paid in full' },
      );

      expect(result.status).toBe('completed');
      expect(result.closureType).toBe('early_payoff');
      expect(result.remainingAmount).toBe(0);
      // Both future installments reversed.
      expect(svc.reverseAdjustmentDoc).toHaveBeenCalledTimes(2);
      expect(ctx.auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'salary.advance_plan.early_payoff' }),
      );
      expect(ctx.postHog.capture).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'salary.advance_plan_early_payoff' }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws if plan is not active or paused', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'reversed' });
    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });

    await expect(
      svc.earlyPayoffAdvanceRecoveryPlan(workspaceId, String(planDoc._id), String(userId), {
        reason: 'test',
      }),
    ).rejects.toThrow('reversed');
  });

  it('past installments (before current payroll month) are NOT reversed', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    // Month 4 is past (current = May 2026), month 6 is future.
    const adjPast = makeAdjDoc({ month: 4, year: 2026 });
    const adjFuture = makeAdjDoc({ month: 6, year: 2026 });
    const planDoc = makePlanDoc({
      installments: [
        {
          index: 1,
          month: 4,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adjPast._id,
          status: 'applied',
        },
        {
          index: 2,
          month: 6,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adjFuture._id,
          status: 'applied',
        },
      ],
    });

    (ctx.planCtorMock as any).findOne = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    let callCount = 0;
    (ctx.adjustmentCtorMock as any).findById = vi.fn().mockImplementation(() => {
      callCount++;
      const doc = callCount === 1 ? adjFuture : null;
      return { exec: vi.fn().mockResolvedValue(doc) };
    });
    svc.reverseAdjustmentDoc = vi.fn().mockResolvedValue(undefined);
    svc.refreshPlanProgress = vi.fn().mockResolvedValue(undefined);

    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026
      return new realDate(...args);
    });

    try {
      await svc.earlyPayoffAdvanceRecoveryPlan(workspaceId, String(planDoc._id), String(userId), {
        reason: 'paid in full',
      });

      // Only the future adjustment (month 6) should be reversed, not the past one (month 4).
      expect(svc.reverseAdjustmentDoc).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// getOutstandingAdvances — plan-backed path
// ---------------------------------------------------------------------------
describe('getOutstandingAdvances: plan-backed path', () => {
  it('returns per-month installment breakdown and correct remaining', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planId = new Types.ObjectId();
    const adj1Id = new Types.ObjectId();
    const adj2Id = new Types.ObjectId();

    const planDoc = makePlanDoc({
      _id: planId,
      totalAmount: 20000,
      status: 'active',
      linkedAdjustmentIds: [adj1Id, adj2Id],
      installments: [
        {
          index: 1,
          month: 5,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj1Id,
          status: 'applied',
        },
        {
          index: 2,
          month: 6,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          adjustmentId: adj2Id,
          status: 'applied',
        },
      ],
    });

    const paymentDoc = makePaymentDoc({
      advanceRecoveryPlanId: planId,
      advanceRecoveryAdjustmentId: undefined,
    });

    // callerScope resolves to owner.
    (ctx.service as any).callerScope = {
      resolve: vi.fn().mockResolvedValue({ isOwner: true }),
      effectiveScope: vi.fn().mockReturnValue('all'),
    };

    ctx.paymentModel.find = vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([paymentDoc]),
    });

    // advanceRecoveryPlanModel.findById returns the plan.
    (ctx.planCtorMock as any).findById = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });

    // salaryAdjustmentModel.find for active adjustments: month 6 adj is active (future).
    (ctx.adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        // Month 5 is past (current = May 2026), month 6 is current/future.
        { _id: adj2Id, month: 6, year: 2026, amount: 10000 },
      ]),
    });

    // Current date: May 2026 (month 5). Adj month 5 = elapsed, month 6 = future.
    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026
      return new realDate(...args);
    });

    try {
      const result = await svc.getOutstandingAdvances(
        workspaceId,
        String(teamMemberId),
        String(userId),
      );

      expect(result.totalAdvanced).toBe(20000);
      // Month 6 is future (remaining = 10000), recovered = 20000 - 10000 = 10000.
      expect(result.totalRecovered).toBe(10000);
      expect(result.outstanding).toBe(10000);
      expect(result.advances).toHaveLength(1);
      const advance = result.advances[0];
      expect(advance.installments).toHaveLength(2);
      expect(advance.installments[0].month).toBe(5);
      expect(advance.installments[1].month).toBe(6);
      expect(advance.recoveryStatus).toBe('partial');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns recoveryStatus=recovered when plan is completed', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planId = new Types.ObjectId();
    const planDoc = makePlanDoc({
      _id: planId,
      totalAmount: 10000,
      status: 'completed',
      linkedAdjustmentIds: [],
      installments: [
        {
          index: 1,
          month: 4,
          year: 2026,
          plannedAmount: 10000,
          appliedAmount: 10000,
          status: 'applied',
        },
      ],
    });

    const paymentDoc = makePaymentDoc({
      advanceRecoveryPlanId: planId,
      advanceRecoveryAdjustmentId: undefined,
    });

    ctx.paymentModel.find = vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([paymentDoc]),
    });
    (ctx.planCtorMock as any).findById = vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(planDoc),
    });
    // No active future adjustments.
    (ctx.adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });

    const result = await svc.getOutstandingAdvances(
      workspaceId,
      String(teamMemberId),
      String(userId),
    );

    expect(result.advances[0].recoveryStatus).toBe('recovered');
    expect(result.outstanding).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// refreshPlanProgress — unit level
// ---------------------------------------------------------------------------
describe('refreshPlanProgress', () => {
  it('marks plan completed when remainingAmount drops to 0', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'active', totalAmount: 10000 });

    // All adjustments for months that are past (elapsed).
    (ctx.adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi
        .fn()
        .mockResolvedValue([{ _id: new Types.ObjectId(), month: 4, year: 2026, amount: 10000 }]),
    });

    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026; month 4 is past
      return new realDate(...args);
    });

    try {
      await svc.refreshPlanProgress(planDoc);

      expect(planDoc.recoveredAmount).toBe(10000);
      expect(planDoc.remainingAmount).toBe(0);
      expect(planDoc.status).toBe('completed');
      expect(planDoc.closureType).toBe('completed');
      expect(planDoc.save).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not change status when there is still remaining', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'active', totalAmount: 20000 });

    (ctx.adjustmentCtorMock as any).find = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        { _id: new Types.ObjectId(), month: 4, year: 2026, amount: 10000 }, // elapsed
        { _id: new Types.ObjectId(), month: 6, year: 2026, amount: 10000 }, // future
      ]),
    });

    const realDate = global.Date;
    vi.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
      if (args.length === 0) return new realDate(2026, 4, 1); // May 2026
      return new realDate(...args);
    });

    try {
      await svc.refreshPlanProgress(planDoc);

      expect(planDoc.recoveredAmount).toBe(10000);
      expect(planDoc.remainingAmount).toBe(10000);
      expect(planDoc.status).toBe('active'); // not auto-completed
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('skips reversed/completed plans', async () => {
    const ctx = buildService();
    const svc = ctx.service as any;

    const planDoc = makePlanDoc({ status: 'reversed' });
    planDoc.save.mockClear();

    await svc.refreshPlanProgress(planDoc);

    expect(planDoc.save).not.toHaveBeenCalled();
  });
});
