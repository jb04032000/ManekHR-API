/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service. Importing the
// loan DTO transitively pulls employer-loan.schema, whose @Prop decorations trip
// vitest's reflect-metadata pipeline ("Cannot determine type"). We never use
// Mongoose here — every Model is injected as a plain mock. Mirrors
// auth.service.audit.vitest.ts.
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
import { ConflictException } from '@nestjs/common';
import { LoanRequestService } from '../loan-request.service';

/**
 * Unit coverage for the employee self-service LoanRequest lifecycle (Task 2):
 *   - createRequest happy path binds to the JWT-resolved teamMemberId (NOT a body id),
 *   - the self-apply AND-gate (LOAN_SELF_APPLY_DISABLED),
 *   - eligibility caps (LOAN_AMOUNT_EXCEEDS_CAP / LOAN_TENURE_NOT_MET),
 *   - E11000 → 409 LOAN_REQUEST_DUPLICATE,
 *   - approveRequest materializes a 0% EmployerLoan via LoanService.createLoan,
 *   - rejectRequest sets rejected + reason; both require a pending request.
 *
 * LoanService.createLoan is mocked — the real amortization engine is NOT exercised.
 */
describe('LoanRequestService', () => {
  const workspaceId = new Types.ObjectId().toHexString();
  const callerUserId = new Types.ObjectId().toHexString();
  const ownTeamMemberId = new Types.ObjectId().toHexString();
  const requestId = new Types.ObjectId().toHexString();

  let loanRequestModel: any;
  let payrollConfigModel: any;
  let employerLoanModel: any;
  let teamMemberModel: any;
  let loanService: { createLoan: ReturnType<typeof vi.fn> };
  let callerScope: { resolve: ReturnType<typeof vi.fn> };
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let svc: LoanRequestService;

  // A loanConfig that ENABLES self-apply with no caps, unless a test overrides.
  let loanConfig: any;

  const makeConfig = () => ({
    features: { loanManagement: true },
    loanConfig,
  });

  beforeEach(() => {
    loanConfig = {
      selfApplyEnabled: true,
      selfApplyMinTenureMonths: null,
      selfApplyMaxAmount: null,
      maxActiveLoanAmount: 0,
      maxActiveLoanCount: 0,
    };

    loanRequestModel = {
      create: vi.fn(),
      find: vi.fn(),
      findOne: vi.fn(),
      countDocuments: vi.fn().mockResolvedValue(0),
    };

    payrollConfigModel = {
      findOne: vi.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(makeConfig()) }),
      }),
    };

    employerLoanModel = {
      find: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
      countDocuments: vi.fn().mockResolvedValue(0),
    };

    teamMemberModel = {
      findById: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve({}) }) }),
        lean: () => ({ exec: () => Promise.resolve({}) }),
      }),
    };

    loanService = {
      createLoan: vi.fn(),
    };

    callerScope = {
      resolve: vi.fn().mockResolvedValue({ teamMemberId: ownTeamMemberId, isOwner: false }),
    };

    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };

    svc = new LoanRequestService(
      loanRequestModel,
      payrollConfigModel,
      employerLoanModel,
      teamMemberModel,
      loanService as any,
      callerScope as any,
      auditService as any,
    );
  });

  const settle = () => new Promise((r) => setImmediate(r));

  describe('createRequest', () => {
    it('creates a pending request bound to the JWT-resolved teamMemberId (not a body id)', async () => {
      const created = { _id: new Types.ObjectId(), status: 'pending' };
      loanRequestModel.create.mockResolvedValue(created);

      const result = await svc.createRequest(workspaceId, callerUserId, ownTeamMemberId, {
        requestedAmount: 500000,
        desiredTenorMonths: 10,
      } as any);

      expect(result).toBe(created);
      expect(loanRequestModel.create).toHaveBeenCalledTimes(1);
      const arg = loanRequestModel.create.mock.calls[0][0];
      // The persisted member id is the resolved own id, never a body field.
      expect(String(arg.teamMemberId)).toBe(ownTeamMemberId);
      expect(String(arg.workspaceId)).toBe(workspaceId);
      expect(arg.requestedAmount).toBe(500000);
      expect(arg.desiredTenorMonths).toBe(10);
      expect(arg.status).toBe('pending');

      await settle();
      expect(auditService.logEvent).toHaveBeenCalled();
    });

    it('throws LOAN_SELF_APPLY_DISABLED when selfApplyEnabled is false', async () => {
      loanConfig.selfApplyEnabled = false;

      await expect(
        svc.createRequest(workspaceId, callerUserId, ownTeamMemberId, {
          requestedAmount: 500000,
          desiredTenorMonths: 10,
        } as any),
      ).rejects.toMatchObject({ response: { code: 'LOAN_SELF_APPLY_DISABLED' } });

      expect(loanRequestModel.create).not.toHaveBeenCalled();
    });

    it('throws LOAN_AMOUNT_EXCEEDS_CAP when requestedAmount is over selfApplyMaxAmount', async () => {
      loanConfig.selfApplyMaxAmount = 100000; // cap = Rs 1000 in paise

      await expect(
        svc.createRequest(workspaceId, callerUserId, ownTeamMemberId, {
          requestedAmount: 100001,
          desiredTenorMonths: 10,
        } as any),
      ).rejects.toMatchObject({ response: { code: 'LOAN_AMOUNT_EXCEEDS_CAP' } });

      expect(loanRequestModel.create).not.toHaveBeenCalled();
    });

    it('throws LOAN_TENURE_NOT_MET when the member is under the min tenure', async () => {
      loanConfig.selfApplyMinTenureMonths = 6;
      // Joined one month ago → under the 6-month minimum.
      const joinedRecently = new Date();
      joinedRecently.setMonth(joinedRecently.getMonth() - 1);
      teamMemberModel.findById.mockReturnValue({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve({ dateOfJoining: joinedRecently }) }),
        }),
        lean: () => ({ exec: () => Promise.resolve({ dateOfJoining: joinedRecently }) }),
      });

      await expect(
        svc.createRequest(workspaceId, callerUserId, ownTeamMemberId, {
          requestedAmount: 500000,
          desiredTenorMonths: 10,
        } as any),
      ).rejects.toMatchObject({ response: { code: 'LOAN_TENURE_NOT_MET' } });

      expect(loanRequestModel.create).not.toHaveBeenCalled();
    });

    it('maps an E11000 duplicate-key error to a 409 LOAN_REQUEST_DUPLICATE', async () => {
      loanRequestModel.create.mockRejectedValue({ code: 11000 });

      await expect(
        svc.createRequest(workspaceId, callerUserId, ownTeamMemberId, {
          requestedAmount: 500000,
          desiredTenorMonths: 10,
        } as any),
      ).rejects.toMatchObject({ response: { code: 'LOAN_REQUEST_DUPLICATE' } });

      const err = await svc
        .createRequest(workspaceId, callerUserId, ownTeamMemberId, {
          requestedAmount: 500000,
          desiredTenorMonths: 10,
        } as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
    });
  });

  describe('approveRequest', () => {
    const makePendingRequest = () => {
      const doc: any = {
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(ownTeamMemberId),
        requestedAmount: 750000,
        desiredTenorMonths: 12,
        status: 'pending',
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
      };
      doc.save = vi.fn().mockResolvedValue(doc);
      return doc;
    };

    it('calls createLoan with interestType zero + requestedAmount default and marks approved', async () => {
      const request = makePendingRequest();
      loanRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(request) });
      const newLoan = { _id: new Types.ObjectId() };
      loanService.createLoan.mockResolvedValue(newLoan);
      // owner resolves to a DIFFERENT member id (SoD-safe).
      callerScope.resolve.mockResolvedValue({
        teamMemberId: new Types.ObjectId().toHexString(),
        isOwner: true,
      });

      const result = await svc.approveRequest(workspaceId, requestId, callerUserId, {
        tenorMonths: 12,
        startMonth: 7,
        startYear: 2026,
      } as any);

      expect(loanService.createLoan).toHaveBeenCalledTimes(1);
      const [wsArg, dtoArg, userArg] = loanService.createLoan.mock.calls[0];
      expect(wsArg).toBe(workspaceId);
      expect(userArg).toBe(callerUserId);
      expect(dtoArg.teamMemberId).toBe(ownTeamMemberId);
      expect(dtoArg.interestType).toBe('zero');
      expect(dtoArg.annualInterestRate).toBe(0);
      // principal defaults to the request's requestedAmount (750000 paise), converted
      // to RUPEES (7500) for the rupee-denominated EmployerLoan engine.
      expect(dtoArg.principalAmount).toBe(7500);
      expect(dtoArg.tenorMonths).toBe(12);

      expect(request.status).toBe('approved');
      expect(String(request.createdEmployerLoanId)).toBe(String(newLoan._id));
      expect(request.reviewedAt).toBeInstanceOf(Date);
      expect(result).toBe(request);

      await settle();
      expect(auditService.logEvent).toHaveBeenCalled();
    });

    it('uses dto.principalAmount when provided', async () => {
      const request = makePendingRequest();
      loanRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(request) });
      loanService.createLoan.mockResolvedValue({ _id: new Types.ObjectId() });
      callerScope.resolve.mockResolvedValue({ teamMemberId: null, isOwner: true });

      await svc.approveRequest(workspaceId, requestId, callerUserId, {
        tenorMonths: 6,
        startMonth: 7,
        startYear: 2026,
        principalAmount: 300000,
        interestType: 'zero',
      } as any);

      const dtoArg = loanService.createLoan.mock.calls[0][1];
      // 300000 paise override -> 3000 rupees for the EmployerLoan engine.
      expect(dtoArg.principalAmount).toBe(3000);
    });

    it('rejects approving a non-pending request with LOAN_REQUEST_NOT_PENDING', async () => {
      const request = makePendingRequest();
      request.status = 'approved';
      loanRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(request) });

      await expect(
        svc.approveRequest(workspaceId, requestId, callerUserId, {
          tenorMonths: 12,
          startMonth: 7,
          startYear: 2026,
        } as any),
      ).rejects.toMatchObject({ response: { code: 'LOAN_REQUEST_NOT_PENDING' } });

      expect(loanService.createLoan).not.toHaveBeenCalled();
    });
  });

  describe('rejectRequest', () => {
    const makePendingRequest = () => {
      const doc: any = {
        _id: new Types.ObjectId(requestId),
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(ownTeamMemberId),
        status: 'pending',
      };
      doc.save = vi.fn().mockResolvedValue(doc);
      return doc;
    };

    it('sets status rejected + rejectionReason', async () => {
      const request = makePendingRequest();
      loanRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(request) });
      callerScope.resolve.mockResolvedValue({ teamMemberId: null, isOwner: true });

      const result = await svc.rejectRequest(workspaceId, requestId, callerUserId, {
        reason: 'Insufficient tenure',
      } as any);

      expect(request.status).toBe('rejected');
      expect(request.rejectionReason).toBe('Insufficient tenure');
      expect(request.reviewedAt).toBeInstanceOf(Date);
      expect(result).toBe(request);

      await settle();
      expect(auditService.logEvent).toHaveBeenCalled();
    });

    it('rejects a non-pending request with LOAN_REQUEST_NOT_PENDING', async () => {
      const request = makePendingRequest();
      request.status = 'cancelled';
      loanRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(request) });

      await expect(
        svc.rejectRequest(workspaceId, requestId, callerUserId, {
          reason: 'x',
        } as any),
      ).rejects.toMatchObject({ response: { code: 'LOAN_REQUEST_NOT_PENDING' } });
    });
  });
});
