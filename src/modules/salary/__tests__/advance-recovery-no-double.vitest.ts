/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * PAYROLL-CRITICAL — disbursed advances must NOT be recovered twice.
 *
 * Two recovery paths exist for a disbursed advance:
 *   (A) an EXPLICIT recovery created at disburse time — a multi-installment
 *       `AdvanceRecoveryPlan`, OR a single `SalaryAdjustment` deduction via
 *       `createAdvanceRecoveryDeduction`; and
 *   (B) the salary-generation safety net `applyAdvanceAutoDeductions`, which
 *       creates a lump deduction for every `status:'paid'` advance that has no
 *       recovery marker on the REQUEST.
 *
 * The disburse paths link the explicit recovery onto the *Payment* but never
 * stamp the *request* — so the safety net fires again and the worker is
 * docked twice. This spec pins the query-filter contract + the marker stamping
 * so the two paths can never both run for the same advance.
 *
 * Strategy: `applyAdvanceAutoDeductions` is private, so we invoke it via
 * `(service as any)` and (1) capture the FILTER passed to
 * advanceSalaryRequestModel.find, and (2) assert whether the
 * salaryAdjustmentModel constructor was called for an advance that already
 * carries an explicit recovery marker.
 *
 * Decorator-mock pattern: see advance-disburse.two-step.vitest.ts /
 * salary.service.advance-balance.vitest.ts.
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

const workspaceId = new Types.ObjectId().toHexString();

function noopModel() {
  return {
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    countDocuments: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(0) }),
  };
}

/**
 * salaryAdjustmentModel must be a constructor: applyAdvanceAutoDeductions does
 * `new this.salaryAdjustmentModel(data)` then `.save()`. We record every
 * construction so the test can assert whether an auto-deduction was created.
 */
function makeAdjustmentCtor() {
  const ctor: any = vi.fn().mockImplementation((data: any) => ({
    _id: new Types.ObjectId(),
    ...data,
    save: vi.fn().mockResolvedValue(undefined),
  }));
  return ctor;
}

/**
 * Build a SalaryService whose advanceSalaryRequestModel.find captures the query
 * filter and returns one PAID advance that already has an EXPLICIT recovery
 * (recoveryAdjustmentId UNSET, but a recoveryPlanId IS set — i.e. a multi-
 * installment plan was created at disburse). This is exactly the advance the
 * safety net must NOT touch.
 */
function buildService() {
  const adjustmentCtor = makeAdjustmentCtor();

  const paidAdvanceWithPlan: any = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId: new Types.ObjectId(),
    month: 5,
    year: 2026,
    approvedAmount: 500000, // PAISE -> ₹5,000
    status: 'paid',
    // recoveryAdjustmentId intentionally UNSET (single-deduction marker absent)
    recoveryPlanId: new Types.ObjectId(), // explicit multi-installment plan exists
    save: vi.fn().mockResolvedValue(undefined),
  };

  let capturedFindFilter: any = null;
  const advanceSalaryRequestModel: any = {
    find: vi.fn().mockImplementation((filter: any) => {
      capturedFindFilter = filter;
      return { exec: vi.fn().mockResolvedValue([paidAdvanceWithPlan]) };
    }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
  };

  const service = new SalaryService(
    noopModel() as any, // 1 salaryModel
    noopModel() as any, // 2 paymentModel
    noopModel() as any, // 3 teamModel
    noopModel() as any, // 4 attendanceModel
    noopModel() as any, // 5 incrementModel
    adjustmentCtor, // 6 salaryAdjustmentModel (ctor)
    noopModel() as any, // 7 payrollConfigModel
    noopModel() as any, // 8 ptSlabConfigModel
    noopModel() as any, // 9 componentTemplateModel
    noopModel() as any, // 10 workspaceModel
    noopModel() as any, // 11 subscriptionModel
    noopModel() as any, // 12 bulkEmailJobModel
    noopModel() as any, // 13 userModel
    noopModel() as any, // 14 shiftModel
    noopModel() as any, // 15 leaveRequestModel
    noopModel() as any, // 16 leaveTypeModel
    noopModel() as any, // 17 productionLogModel
    noopModel() as any, // 18 machineModel
    noopModel() as any, // 19 pieceRateConfigAuditModel
    noopModel() as any, // 20 advanceRecoveryPlanModel
    {} as any, // 21 auditService
    {} as any, // 22 mailService
    {} as any, // 23 payslipPdfService
    {} as any, // 24 complianceExportService
    {} as any, // 25 tdsService
    {} as any, // 26 gratuityService
    {} as any, // 27 fnfService
    {} as any, // 28 attendancePoliciesService
    {} as any, // 29 teamService
    { resolve: vi.fn(), effectiveScope: vi.fn() } as any, // 30 callerScope
    { capture: vi.fn(), identify: vi.fn() } as any, // 31 postHog
    {} as any, // 32 complianceGuard
    noopModel() as any, // 33 employerLoanModel
    {} as any, // 34 salaryDisbursementGuardService
    {} as any, // 35 salaryLedgerPostingService
    {} as any, // 36 advanceSalaryRequestService
    advanceSalaryRequestModel, // 37 advanceSalaryRequestModel
  );

  return {
    service,
    adjustmentCtor,
    advanceSalaryRequestModel,
    paidAdvanceWithPlan,
    getFilter: () => capturedFindFilter,
  };
}

describe('SalaryService.applyAdvanceAutoDeductions — no double recovery', () => {
  let ctx: ReturnType<typeof buildService>;
  beforeEach(() => {
    ctx = buildService();
  });

  it('the find filter EXCLUDES advances that already have an explicit plan (BOTH markers guarded)', async () => {
    const svc = ctx.service as any;
    const salary: any = {
      _id: new Types.ObjectId(),
      teamMemberId: new Types.ObjectId(),
      month: 7,
      year: 2026,
    };

    await svc.applyAdvanceAutoDeductions(workspaceId, salary);

    const filter = ctx.getFilter();
    expect(filter).toBeTruthy();
    // Existing single-deduction guard.
    expect(filter.recoveryAdjustmentId).toEqual({ $exists: false });
    // NEW guard: a multi-installment plan also excludes the advance from the safety net.
    expect(filter.recoveryPlanId).toEqual({ $exists: false });
  });

  it('still auto-deducts a genuinely-unrecovered paid advance (BOTH markers unset) — safety net intact', async () => {
    // Override the find result with an advance that has NEITHER marker.
    const unrecovered: any = {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(workspaceId),
      teamMemberId: new Types.ObjectId(),
      month: 5,
      year: 2026,
      approvedAmount: 500000, // PAISE -> ₹5,000
      status: 'paid',
      save: vi.fn().mockResolvedValue(undefined),
    };
    ctx.advanceSalaryRequestModel.find.mockReturnValue({
      exec: vi.fn().mockResolvedValue([unrecovered]),
    });

    const svc = ctx.service as any;
    const salary: any = {
      _id: new Types.ObjectId(),
      teamMemberId: new Types.ObjectId(),
      month: 7,
      year: 2026,
    };

    await svc.applyAdvanceAutoDeductions(workspaceId, salary);

    // A deduction WAS created (the safety net fired) — and the recovery amount is
    // the paise→rupee conversion (₹5,000), NOT the raw paise.
    expect(ctx.adjustmentCtor).toHaveBeenCalledTimes(1);
    const adj = ctx.adjustmentCtor.mock.calls[0][0];
    expect(adj.type).toBe('deduction');
    expect(adj.category).toBe('advance_recovery');
    expect(adj.amount).toBe(5000);
    // And the request was stamped with the idempotency marker.
    expect(unrecovered.recoveryAdjustmentId).toBeDefined();
    expect(unrecovered.save).toHaveBeenCalled();
  });
});

// ───────────────── disburse stamps the marker on the REQUEST ─────────────────

/** Payment model must be a constructor (the method does `new this.paymentModel`). */
function makePaymentCtor() {
  const ctor: any = vi.fn().mockImplementation((data: any) => ({
    _id: new Types.ObjectId(),
    ...data,
    save: vi.fn().mockResolvedValue(undefined),
  }));
  ctor.findOne = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  ctor.findById = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  return ctor;
}

function buildDisburseService() {
  const paymentCtor = makePaymentCtor();
  const reqId = new Types.ObjectId().toHexString();

  const requestDoc: any = {
    _id: new Types.ObjectId(reqId),
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId: new Types.ObjectId(),
    month: 6,
    year: 2026,
    requestedAmount: 30000,
    approvedAmount: 30000, // PAISE -> ₹300
    status: 'approved',
    paymentId: undefined,
  };

  const advanceSalaryRequestModel: any = {
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
  };

  // markPaid records the recovery object it was called with so we can assert the
  // disburse path stamps the right marker on the REQUEST.
  const advanceSalaryRequestService = {
    markPaid: vi
      .fn()
      .mockImplementation(
        (_ws: string, _id: string, paymentId: string, recovery?: Record<string, unknown>) =>
          Promise.resolve({ ...requestDoc, status: 'paid', paymentId, ...(recovery ?? {}) }),
      ),
    notifyAdvanceDisbursed: vi.fn().mockResolvedValue(undefined),
  };

  const salaryLedgerPostingService = {
    postAdvancePayment: vi.fn().mockResolvedValue({ posted: true }),
  };
  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const service = new SalaryService(
    noopModel() as any, // 1 salaryModel
    paymentCtor, // 2 paymentModel (ctor)
    noopModel() as any, // 3 teamModel
    noopModel() as any, // 4 attendanceModel
    noopModel() as any, // 5 incrementModel
    noopModel() as any, // 6 salaryAdjustmentModel
    noopModel() as any, // 7 payrollConfigModel
    noopModel() as any, // 8 ptSlabConfigModel
    noopModel() as any, // 9 componentTemplateModel
    noopModel() as any, // 10 workspaceModel
    noopModel() as any, // 11 subscriptionModel
    noopModel() as any, // 12 bulkEmailJobModel
    noopModel() as any, // 13 userModel
    noopModel() as any, // 14 shiftModel
    noopModel() as any, // 15 leaveRequestModel
    noopModel() as any, // 16 leaveTypeModel
    noopModel() as any, // 17 productionLogModel
    noopModel() as any, // 18 machineModel
    noopModel() as any, // 19 pieceRateConfigAuditModel
    noopModel() as any, // 20 advanceRecoveryPlanModel
    auditService as any, // 21
    {} as any, // 22 mailService
    {} as any, // 23 payslipPdfService
    {} as any, // 24 complianceExportService
    {} as any, // 25 tdsService
    {} as any, // 26 gratuityService
    {} as any, // 27 fnfService
    {} as any, // 28 attendancePoliciesService
    {} as any, // 29 teamService
    { resolve: vi.fn(), effectiveScope: vi.fn() } as any, // 30 callerScope
    postHog as any, // 31 postHog
    {} as any, // 32 complianceGuard
    noopModel() as any, // 33 employerLoanModel
    {} as any, // 34 salaryDisbursementGuardService
    salaryLedgerPostingService as any, // 35
    advanceSalaryRequestService as any, // 36
    advanceSalaryRequestModel, // 37
  );

  vi.spyOn(service as any, 'assertNotSelfSalaryEdit').mockResolvedValue(undefined);
  vi.spyOn(service as any, 'assertMemberWritableForSalary').mockResolvedValue(undefined);
  vi.spyOn(service as any, 'ensureSalaryRecord').mockResolvedValue({ _id: new Types.ObjectId() });
  vi.spyOn(service as any, 'assertFeatureEnabled').mockResolvedValue(undefined);
  const planId = new Types.ObjectId();
  const adjId = new Types.ObjectId();
  vi.spyOn(service as any, 'createAdvanceRecoveryPlan').mockResolvedValue({
    plan: { _id: planId },
    complianceWarnings: [],
  });
  vi.spyOn(service as any, 'createAdvanceRecoveryDeduction').mockResolvedValue({ _id: adjId });

  return { service, advanceSalaryRequestService, reqId, planId, adjId };
}

describe('SalaryService.payApprovedAdvance — stamps the explicit-recovery marker on the request', () => {
  const reviewerUserId = new Types.ObjectId().toHexString();

  it('multi-installment (installmentCount > 1) → markPaid stamps recoveryPlanId (not recoveryAdjustmentId)', async () => {
    const ctx = buildDisburseService();
    const svc = ctx.service as any;

    await svc.payApprovedAdvance(workspaceId, reviewerUserId, ctx.reqId, {
      paymentMode: 'cash',
      installmentCount: 3,
    });

    expect(ctx.advanceSalaryRequestService.markPaid).toHaveBeenCalledTimes(1);
    const recoveryArg = ctx.advanceSalaryRequestService.markPaid.mock.calls[0][3];
    expect(recoveryArg.recoveryPlanId).toBe(String(ctx.planId));
    expect(recoveryArg.recoveryAdjustmentId).toBeUndefined();
  });

  it('single lump deduction (no installment config) → markPaid stamps recoveryAdjustmentId (not recoveryPlanId)', async () => {
    const ctx = buildDisburseService();
    const svc = ctx.service as any;

    await svc.payApprovedAdvance(workspaceId, reviewerUserId, ctx.reqId, { paymentMode: 'cash' });

    expect(ctx.advanceSalaryRequestService.markPaid).toHaveBeenCalledTimes(1);
    const recoveryArg = ctx.advanceSalaryRequestService.markPaid.mock.calls[0][3];
    expect(recoveryArg.recoveryAdjustmentId).toBe(String(ctx.adjId));
    expect(recoveryArg.recoveryPlanId).toBeUndefined();
  });
});
