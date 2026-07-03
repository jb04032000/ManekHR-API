/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Phase 1b — two-step approve -> payout-day disburse.
 *
 * Task 2: the HTTP `approve` route APPROVES ONLY (pending -> approved + sets
 * approvedAmount), records NO Payment. It calls the existing approve-only service
 * (advanceSalaryRequestService.approve), NOT the combined
 * SalaryService.approveAndDisburseAdvanceRequest (which stays for back-compat).
 *
 * Task 3: SalaryService.payApprovedAdvance is now the full DISBURSE step. After
 * recording the base Payment it (a) gates + attaches split lines, (b) persists
 * proof/who-disbursed, (c) CREATES the recovery (multi-installment plan OR single
 * deduction — lifted from the combined method), (d) audits + notifies + flips
 * approved -> paid. The biggest regression guard: recovery MUST be created at
 * disburse now.
 *
 * Links: advance-salary-request.controller.ts (approve/pay routes),
 * salary.service.ts payApprovedAdvance, advance-salary-request.service.ts approve.
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
import { AdvanceSalaryRequestController } from '../advance-salary-request.controller';
import { SalaryService } from '../salary.service';

const workspaceId = new Types.ObjectId().toHexString();
const requestId = new Types.ObjectId().toHexString();
const reviewerUserId = new Types.ObjectId().toHexString();
const teamMemberId = new Types.ObjectId();

// ───────────────────────── Task 2: approve-only route ─────────────────────────

describe('AdvanceSalaryRequestController.approve — approve-only (no disburse)', () => {
  it('calls the approve-only service with {approvedAmount, reviewNote} and NEVER disburses', async () => {
    const advanceSalaryRequestService = {
      approve: vi
        .fn()
        .mockResolvedValue({ _id: requestId, status: 'approved', approvedAmount: 50000 }),
    };
    const salaryService = {
      approveAndDisburseAdvanceRequest: vi.fn(),
      payApprovedAdvance: vi.fn(),
    };
    const callerScope = { resolve: vi.fn() };
    const controller = new AdvanceSalaryRequestController(
      advanceSalaryRequestService as any,
      salaryService as any,
      callerScope as any,
    );

    const result = await controller.approve(
      workspaceId,
      requestId,
      { user: { sub: reviewerUserId } } as any,
      // recovery-term fields may still be present (legacy DTO) but the route ignores them
      { approvedAmount: 50000, reviewNote: 'ok', installmentCount: 3 } as any,
    );

    expect(advanceSalaryRequestService.approve).toHaveBeenCalledWith(
      workspaceId,
      requestId,
      reviewerUserId,
      { approvedAmount: 50000, reviewNote: 'ok' },
    );
    // The combined approve+disburse method MUST NOT be invoked by the approve route.
    expect(salaryService.approveAndDisburseAdvanceRequest).not.toHaveBeenCalled();
    // No payout happened at approve time.
    expect(salaryService.payApprovedAdvance).not.toHaveBeenCalled();
    expect(result.status).toBe('approved');
  });
});

// ───────────────────────── Task 3: disburse step ─────────────────────────

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

function buildDisburseService() {
  const paymentCtor = makePaymentCtor();

  // An APPROVED request awaiting payout. approvedAmount is PAISE (30000 -> ₹300).
  const requestDoc: any = {
    _id: new Types.ObjectId(requestId),
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId,
    month: 6,
    year: 2026,
    requestedAmount: 30000,
    approvedAmount: 30000,
    status: 'approved',
    paymentId: undefined,
  };

  const advanceSalaryRequestModel: any = {
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
    findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(requestDoc) }),
  };

  const advanceSalaryRequestService = {
    markPaid: vi
      .fn()
      .mockImplementation((_ws: string, _id: string, paymentId: string) =>
        Promise.resolve({ ...requestDoc, status: 'paid', paymentId }),
      ),
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

  // SoD + member-writable guards are exercised elsewhere; here we no-op them so we
  // assert the new disburse behaviour (split/proof/recovery) directly.
  vi.spyOn(service as any, 'assertNotSelfSalaryEdit').mockResolvedValue(undefined);
  vi.spyOn(service as any, 'assertMemberWritableForSalary').mockResolvedValue(undefined);
  vi.spyOn(service as any, 'ensureSalaryRecord').mockResolvedValue({ _id: new Types.ObjectId() });
  vi.spyOn(service as any, 'assertFeatureEnabled').mockResolvedValue(undefined);
  const planId = new Types.ObjectId();
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
    salaryDisbursementGuardService,
    auditService,
    postHog,
    requestDoc,
    planId,
  };
}

describe('SalaryService.payApprovedAdvance — disburse with split/proof/who + recovery', () => {
  let ctx: ReturnType<typeof buildDisburseService>;
  beforeEach(() => {
    ctx = buildDisburseService();
  });

  it('creates a multi-installment AdvanceRecoveryPlan when installmentCount > 1', async () => {
    const svc = ctx.service as any;

    const result = await svc.payApprovedAdvance(workspaceId, reviewerUserId, requestId, {
      paymentMode: 'cash',
      installmentCount: 3,
    });

    // Recovery plan engine invoked: amount in RUPEES (30000 PAISE -> ₹300),
    // start month defaults to request.month + 1 (6 -> 7).
    expect(svc.createAdvanceRecoveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        totalAmount: 300,
        startMonth: 7,
        startYear: 2026,
        installmentConfig: expect.objectContaining({ installmentCount: 3 }),
      }),
    );
    expect(svc.createAdvanceRecoveryDeduction).not.toHaveBeenCalled();
    expect(ctx.advanceSalaryRequestService.markPaid).toHaveBeenCalledTimes(1);
    expect(result.request.status).toBe('paid');
  });

  it('creates a single lump deduction when NO installment config is given', async () => {
    const svc = ctx.service as any;

    await svc.payApprovedAdvance(workspaceId, reviewerUserId, requestId, { paymentMode: 'cash' });

    expect(svc.createAdvanceRecoveryDeduction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 300, targetMonth: 7, targetYear: 2026 }),
    );
    expect(svc.createAdvanceRecoveryPlan).not.toHaveBeenCalled();
  });

  it('saves split lines on the Payment and enforces the splitPayments feature gate', async () => {
    const svc = ctx.service as any;
    const splitLines = [
      { method: 'bank_transfer', amount: 200 },
      { method: 'cash', amount: 100 },
    ];

    await svc.payApprovedAdvance(workspaceId, reviewerUserId, requestId, {
      paymentMode: 'split',
      splitLines,
    });

    expect(svc.assertFeatureEnabled).toHaveBeenCalledWith(
      workspaceId,
      'splitPayments',
      expect.any(String),
    );
    const paymentData = ctx.paymentCtor.mock.calls[0][0];
    expect(paymentData.splitLines).toEqual(splitLines);
    expect(paymentData.paymentMode).toBe('split');
  });

  it('persists disbursedByName (paidBy), proofUrls, and referenceNo on the Payment', async () => {
    const svc = ctx.service as any;

    await svc.payApprovedAdvance(workspaceId, reviewerUserId, requestId, {
      paymentMode: 'bank_transfer',
      disbursedByName: 'Ramesh',
      proofUrls: ['proof://a', 'proof://b'],
      referenceNo: 'TXN-123',
    });

    const paymentData = ctx.paymentCtor.mock.calls[0][0];
    expect(paymentData.paidBy).toBe('Ramesh');
    expect(paymentData.proofUrls).toEqual(['proof://a', 'proof://b']);
    expect(paymentData.referenceNo).toBe('TXN-123');
    expect(paymentData.isAdvance).toBe(true);
  });

  it('flips the request approved -> paid and audits the disbursement', async () => {
    const svc = ctx.service as any;

    const result = await svc.payApprovedAdvance(workspaceId, reviewerUserId, requestId, {
      paymentMode: 'cash',
    });

    expect(ctx.advanceSalaryRequestService.markPaid).toHaveBeenCalledTimes(1);
    expect(result.request.status).toBe('paid');
    expect(ctx.auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'advance_request.disbursed' }),
    );
    expect(ctx.advanceSalaryRequestService.notifyAdvanceDisbursed).toHaveBeenCalledTimes(1);
  });

  it('rejects disbursing a request that is not approved', async () => {
    const svc = ctx.service as any;
    ctx.advanceSalaryRequestModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ ...ctx.requestDoc, status: 'pending' }),
    });

    await expect(
      svc.payApprovedAdvance(workspaceId, reviewerUserId, requestId, { paymentMode: 'cash' }),
    ).rejects.toThrow();
    expect(ctx.paymentCtor).not.toHaveBeenCalled();
  });
});
