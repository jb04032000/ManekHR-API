/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Core loop: approveAndDisburseAdvanceRequest — the wiring that turns an
 * approved worker advance request into real money + interest-free installment
 * recovery. Previously the loop was dead (markPaid had zero callers, so an
 * approved request never disbursed). This method:
 *   approve (if pending) -> record an isAdvance Payment (linked back via
 *   advanceRequestId) -> create the AdvanceRecoveryPlan (count>1) OR a single
 *   deduction (lump) -> markPaid. Idempotent: an already-paid request, or one
 *   that already has an active advance Payment, does not double-disburse.
 *
 * These tests assert ORCHESTRATION only — the recovery engine
 * (createAdvanceRecoveryPlan / createAdvanceRecoveryDeduction) is already
 * covered by salary.service.advance-plan*.vitest.ts, so it is spied here.
 *
 * Links: salary.service.ts approveAndDisburseAdvanceRequest,
 * advance-salary-request.service.ts approve/markPaid, payment.schema.ts advanceRequestId.
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
const requestId = new Types.ObjectId().toHexString();
const reviewerUserId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();

function noopModel() {
  return {
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    updateMany: vi.fn().mockResolvedValue({}),
    updateOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({}) }),
    collection: { name: 'm' },
  };
}

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

function buildService() {
  const paymentCtor = makePaymentCtor();

  // The request the controller is approving — pending by default.
  const requestDoc: any = {
    _id: new Types.ObjectId(requestId),
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId,
    month: 6,
    year: 2026,
    requestedAmount: 30000,
    approvedAmount: undefined,
    status: 'pending',
    paymentId: undefined,
  };

  const advanceSalaryRequestModel: any = {
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
  };

  const advanceSalaryRequestService = {
    // approve flips pending -> approved and stamps approvedAmount
    approve: vi
      .fn()
      .mockImplementation((_ws: string, _id: string, _user: string, dto: any) =>
        Promise.resolve({ ...requestDoc, status: 'approved', approvedAmount: dto.approvedAmount }),
      ),
    markPaid: vi
      .fn()
      .mockImplementation((_ws: string, _id: string, paymentId: string) =>
        Promise.resolve({ ...requestDoc, status: 'paid', paymentId }),
      ),
    // Step 6: SalaryService fires the worker "advance approved" notification
    // through this best-effort helper (keeps SalaryService's constructor untouched).
    notifyAdvanceDisbursed: vi.fn().mockResolvedValue(undefined),
  };

  const salaryLedgerPostingService = {
    postAdvancePayment: vi.fn().mockResolvedValue({ posted: true }),
  };
  const salaryDisbursementGuardService = {
    assertPaymentAllowed: vi.fn().mockResolvedValue(undefined),
  };
  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };
  const callerScope = {
    resolve: vi.fn().mockResolvedValue({ isOwner: true }),
    effectiveScope: vi.fn().mockReturnValue('all'),
  };

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
    callerScope as any, // 30 callerScope
    postHog as any, // 31 postHog
    {} as any, // 32 complianceGuard
    noopModel() as any, // 33 employerLoanModel
    salaryDisbursementGuardService as any, // 34
    salaryLedgerPostingService as any, // 35
    advanceSalaryRequestService as any, // 36
    advanceSalaryRequestModel, // 37
  );

  // Spy the already-tested private engine helpers + salary-record ensure so we
  // assert orchestration, not the engine internals.
  const planId = new Types.ObjectId();
  vi.spyOn(service as any, 'ensureSalaryRecord').mockResolvedValue({ _id: new Types.ObjectId() });
  vi.spyOn(service as any, 'createAdvanceRecoveryPlan').mockResolvedValue({
    plan: { _id: planId },
    complianceWarnings: [],
  });
  vi.spyOn(service as any, 'createAdvanceRecoveryDeduction').mockResolvedValue({
    _id: new Types.ObjectId(),
  });

  return {
    service,
    paymentCtor,
    advanceSalaryRequestService,
    advanceSalaryRequestModel,
    salaryLedgerPostingService,
    auditService,
    postHog,
    requestDoc,
    planId,
  };
}

describe('SalaryService.approveAndDisburseAdvanceRequest', () => {
  let ctx: ReturnType<typeof buildService>;
  beforeEach(() => {
    ctx = buildService();
  });

  it('approves, records an isAdvance Payment linked to the request, builds the installment plan, and marks paid', async () => {
    const svc = ctx.service as any;

    const result = await svc.approveAndDisburseAdvanceRequest(
      workspaceId,
      requestId,
      reviewerUserId,
      {
        approvedAmount: 30000,
        installmentCount: 3,
      },
    );

    // approve called with the approved amount
    expect(ctx.advanceSalaryRequestService.approve).toHaveBeenCalledWith(
      workspaceId,
      requestId,
      reviewerUserId,
      expect.objectContaining({ approvedAmount: 30000 }),
    );

    // a Payment was created: advance, full approved amount, linked back to the request,
    // recovery starting the month AFTER the request month (6 -> 7)
    expect(ctx.paymentCtor).toHaveBeenCalledTimes(1);
    const paymentData = ctx.paymentCtor.mock.calls[0][0];
    expect(paymentData.isAdvance).toBe(true);
    // approvedAmount 30000 PAISE -> Payment.amount is RUPEES (300)
    expect(paymentData.amount).toBe(300);
    expect(String(paymentData.advanceRequestId)).toBe(requestId);
    expect(paymentData.advanceForMonth).toBe(7);
    expect(paymentData.advanceForYear).toBe(2026);

    // installment plan engine invoked with the approver's config + start month
    expect(svc.createAdvanceRecoveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        totalAmount: 300,
        startMonth: 7,
        startYear: 2026,
        installmentConfig: expect.objectContaining({ installmentCount: 3 }),
      }),
    );
    // NOT the single-deduction path
    expect(svc.createAdvanceRecoveryDeduction).not.toHaveBeenCalled();

    // loop closed: markPaid stamped the payment id
    expect(ctx.advanceSalaryRequestService.markPaid).toHaveBeenCalledTimes(1);
    expect(result.request.status).toBe('paid');
  });

  it('notifies the worker (best-effort) once the advance is disbursed and marked paid', async () => {
    const svc = ctx.service as any;

    await svc.approveAndDisburseAdvanceRequest(workspaceId, requestId, reviewerUserId, {
      approvedAmount: 30000,
      installmentCount: 3,
    });

    expect(ctx.advanceSalaryRequestService.notifyAdvanceDisbursed).toHaveBeenCalledTimes(1);
    const [wsArg, requestArg, reviewerArg] =
      ctx.advanceSalaryRequestService.notifyAdvanceDisbursed.mock.calls[0];
    expect(wsArg).toBe(workspaceId);
    expect(requestArg.status).toBe('paid');
    expect(reviewerArg).toBe(reviewerUserId);
  });

  it('a notification failure does not break the disbursement', async () => {
    const svc = ctx.service as any;
    ctx.advanceSalaryRequestService.notifyAdvanceDisbursed.mockRejectedValue(
      new Error('notify down'),
    );

    const result = await svc.approveAndDisburseAdvanceRequest(
      workspaceId,
      requestId,
      reviewerUserId,
      {
        approvedAmount: 30000,
        installmentCount: 3,
      },
    );

    expect(result.alreadyDisbursed).toBe(false);
    expect(result.request.status).toBe('paid');
  });

  it('uses the single-month (lump) recovery path when no installment config is given', async () => {
    const svc = ctx.service as any;

    await svc.approveAndDisburseAdvanceRequest(workspaceId, requestId, reviewerUserId, {
      approvedAmount: 12000,
    });

    expect(svc.createAdvanceRecoveryDeduction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 120, targetMonth: 7, targetYear: 2026 }),
    );
    expect(svc.createAdvanceRecoveryPlan).not.toHaveBeenCalled();
    expect(ctx.advanceSalaryRequestService.markPaid).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: an already-paid request does not approve or create a second Payment', async () => {
    const svc = ctx.service as any;
    const existingPaymentId = new Types.ObjectId();
    // request already disbursed
    ctx.advanceSalaryRequestModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        ...ctx.requestDoc,
        status: 'paid',
        paymentId: existingPaymentId,
      }),
    });
    ctx.paymentCtor.findById.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ _id: existingPaymentId, isAdvance: true }),
    });

    const result = await svc.approveAndDisburseAdvanceRequest(
      workspaceId,
      requestId,
      reviewerUserId,
      {
        approvedAmount: 30000,
        installmentCount: 3,
      },
    );

    expect(ctx.advanceSalaryRequestService.approve).not.toHaveBeenCalled();
    expect(ctx.paymentCtor).not.toHaveBeenCalled();
    expect(svc.createAdvanceRecoveryPlan).not.toHaveBeenCalled();
    expect(String(result.payment._id)).toBe(String(existingPaymentId));
  });
});
