/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the leave services — the
// transitive schema imports would otherwise trip vitest's esbuild reflection
// pipeline. Mirrors the team W5 audit-spec pattern
// (`team.service.audit.vitest.ts`).
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
import { LeaveService } from '../leave.service';
import { LeaveSettingsService } from '../leave-settings.service';
import { LeaveLedgerService } from '../leave-ledger.service';
import { LeaveDelegationService } from '../leave-delegation.service';
import { LeaveRequestService } from '../leave-request.service';
import { CompOffRequestService } from '../comp-off-request.service';
import { AppModule as AppModuleEnum } from '../../../common/enums/modules.enum';

/**
 * Audit fire-and-forget coverage for Phase 5 W4 leave events.
 *
 * Verifies, for the leave module's instrumented write paths:
 *   - Each meaningful write fires `auditService.logEvent` with
 *     `module: AppModule.LEAVE` + the expected `leave.*` action string.
 *   - Audit failures are swallowed and never break the caller.
 *
 * Mirrors `team.service.audit.vitest.ts` (incl. the `@nestjs/mongoose`
 * decorator-mock pattern). PostHog + Sentry are mocked.
 */
describe('Leave module — audit fire-and-forget (Phase 5 W4)', () => {
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };

  const workspaceId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const leaveTypeId = new Types.ObjectId();

  /** Find the audit call for a given action string. */
  function auditCall(action: string): unknown[] | undefined {
    return auditService.logEvent.mock.calls.find((c: any[]) => c[0].action === action) as
      | unknown[]
      | undefined;
  }

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };
  });

  // ── LeaveService — leave-type catalogue CRUD ───────────────────────────

  describe('LeaveService', () => {
    function makeLeaveTypeModel() {
      return {
        find: vi.fn(),
        findOne: vi.fn(),
        findOneAndUpdate: vi.fn(),
        exists: vi.fn(),
        countDocuments: vi.fn(),
        create: vi.fn(),
      };
    }

    it('fires leave.leave_type_created on createLeaveType success', async () => {
      const model = makeLeaveTypeModel();
      model.exists.mockResolvedValue(null);
      model.countDocuments.mockResolvedValue(2);
      model.create.mockResolvedValue({ _id: leaveTypeId, code: 'CL' });

      const svc = new LeaveService(model as any, auditService as any, postHog as any);
      await svc.createLeaveType(
        workspaceId.toHexString(),
        {
          code: 'cl',
          labels: { en: 'Casual Leave' },
          color: '#000',
          isPaid: true,
          unit: 'day',
        } as any,
        userId.toHexString(),
      );

      const call = auditCall('leave.leave_type_created');
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.LEAVE,
        action: 'leave.leave_type_created',
        entityType: 'leave_type',
        actorId: userId.toHexString(),
        workspaceId: workspaceId.toHexString(),
      });
      expect(call[0].meta).toMatchObject({ code: 'CL', isPaid: true });
    });

    it('fires leave.leave_type_updated on updateLeaveType success', async () => {
      const model = makeLeaveTypeModel();
      model.findOne.mockReturnValue({
        exec: () => Promise.resolve({ _id: leaveTypeId, code: 'CL', isSystem: false }),
      });
      model.findOneAndUpdate.mockReturnValue({
        exec: () => Promise.resolve({ _id: leaveTypeId, code: 'CL' }),
      });

      const svc = new LeaveService(model as any, auditService as any, postHog as any);
      await svc.updateLeaveType(
        workspaceId.toHexString(),
        leaveTypeId.toHexString(),
        { color: '#111' },
        userId.toHexString(),
      );

      const call = auditCall('leave.leave_type_updated');
      expect(call).toBeDefined();
      expect(call[0].entityType).toBe('leave_type');
      expect(call[0].meta.fields).toContain('color');
    });

    it('fires leave.leave_type_archived on deleteLeaveType success', async () => {
      const model = makeLeaveTypeModel();
      const save = vi.fn().mockResolvedValue(undefined);
      model.findOne.mockReturnValue({
        exec: () =>
          Promise.resolve({ _id: leaveTypeId, code: 'CL', isSystem: false, isActive: true, save }),
      });

      const svc = new LeaveService(model as any, auditService as any, postHog as any);
      await svc.deleteLeaveType(
        workspaceId.toHexString(),
        leaveTypeId.toHexString(),
        userId.toHexString(),
      );

      const call = auditCall('leave.leave_type_archived');
      expect(call).toBeDefined();
      expect(call[0].action).toBe('leave.leave_type_archived');
    });

    it('audit failure is swallowed and does NOT break createLeaveType', async () => {
      auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));
      const model = makeLeaveTypeModel();
      model.exists.mockResolvedValue(null);
      model.countDocuments.mockResolvedValue(0);
      model.create.mockResolvedValue({ _id: leaveTypeId, code: 'CL' });

      const svc = new LeaveService(model as any, auditService as any, postHog as any);
      await expect(
        svc.createLeaveType(
          workspaceId.toHexString(),
          { code: 'cl', labels: { en: 'CL' }, color: '#000', isPaid: true, unit: 'day' } as any,
          userId.toHexString(),
        ),
      ).resolves.toBeDefined();
      expect(auditService.logEvent).toHaveBeenCalled();
    });
  });

  // ── LeaveSettingsService — settings update ─────────────────────────────

  describe('LeaveSettingsService', () => {
    it('fires leave.settings_updated on updateSettings success', async () => {
      const settingsId = new Types.ObjectId();
      const model = {
        findOne: vi.fn(),
        findOneAndUpdate: vi.fn().mockReturnValue({
          exec: () => Promise.resolve({ _id: settingsId }),
        }),
        create: vi.fn(),
      };

      const svc = new LeaveSettingsService(model as any, auditService as any, postHog as any);
      await svc.updateSettings(
        workspaceId.toHexString(),
        {
          approverUserIds: [userId.toHexString()],
          sandwichLeave: true,
          retroMaxDaysBack: 7,
          maxAttachmentsPerRequest: 3,
        },
        userId.toHexString(),
      );

      const call = auditCall('leave.settings_updated');
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.LEAVE,
        entityType: 'leave_settings',
        action: 'leave.settings_updated',
      });
      expect(call[0].meta).toMatchObject({ approverCount: 1, sandwichLeave: true });
    });
  });

  // ── LeaveLedgerService — manual balance adjustment ─────────────────────

  describe('LeaveLedgerService', () => {
    it('fires leave.balance_adjusted on postAdjustment success', async () => {
      const ledgerEntryId = new Types.ObjectId();
      const ledgerModel = {
        findOne: vi.fn().mockReturnValue({
          sort: () => ({
            select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
          }),
        }),
        find: vi.fn().mockReturnValue({
          sort: () => ({ select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }) }),
        }),
        create: vi.fn().mockResolvedValue([{ _id: ledgerEntryId, entryType: 'adjustment' }]),
      };
      const balanceModel = {
        findOne: vi.fn().mockReturnValue({
          select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
        }),
        findOneAndUpdate: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
      };

      const svc = new LeaveLedgerService(
        ledgerModel as any,
        balanceModel as any,
        auditService as any,
        postHog as any,
      );
      await svc.postAdjustment(
        {
          workspaceId,
          teamMemberId: memberId,
          leaveTypeId,
          year: 2026,
        },
        2.5,
        userId,
        'Joining-year proration correction',
      );

      const call = auditCall('leave.balance_adjusted');
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.LEAVE,
        entityType: 'leave_balance',
        action: 'leave.balance_adjusted',
        teamMemberId: memberId.toHexString(),
        year: 2026,
      });
      expect(call[0].meta).toMatchObject({ quantity: 2.5 });
    });
  });

  // ── LeaveDelegationService — create / revoke ───────────────────────────

  describe('LeaveDelegationService', () => {
    const delegationId = new Types.ObjectId();
    const toUserId = new Types.ObjectId();

    it('fires leave.delegation_created on createDelegation success', async () => {
      const model = {
        find: vi.fn().mockReturnValue({
          select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
        }),
        findOne: vi.fn(),
        create: vi.fn().mockResolvedValue({ _id: delegationId }),
      };

      const svc = new LeaveDelegationService(model as any, auditService as any, postHog as any);
      await svc.createDelegation({
        workspaceId: workspaceId.toHexString(),
        fromUserId: userId.toHexString(),
        toUserId: toUserId.toHexString(),
        startsOn: '2026-06-01',
        endsOn: '2026-06-10',
      });

      const call = auditCall('leave.delegation_created');
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.LEAVE,
        entityType: 'leave_delegation',
        action: 'leave.delegation_created',
        actorId: userId.toHexString(),
      });
    });

    it('fires leave.delegation_revoked on revokeDelegation success', async () => {
      const save = vi.fn().mockResolvedValue({ _id: delegationId });
      const model = {
        find: vi.fn(),
        findOne: vi.fn().mockReturnValue({
          exec: () =>
            Promise.resolve({
              _id: delegationId,
              fromUserId: userId,
              isActive: true,
              save,
            }),
        }),
        create: vi.fn(),
      };

      const svc = new LeaveDelegationService(model as any, auditService as any, postHog as any);
      await svc.revokeDelegation(
        workspaceId.toHexString(),
        delegationId.toHexString(),
        userId.toHexString(),
      );

      const call = auditCall('leave.delegation_revoked');
      expect(call).toBeDefined();
      expect(call[0].action).toBe('leave.delegation_revoked');
    });
  });

  // ── LeaveRequestService — apply / approve ──────────────────────────────

  describe('LeaveRequestService', () => {
    /** Build a LeaveRequestService whose models satisfy the approve path. */
    function makeRequestService(requestDoc: any) {
      const requestModel = {
        findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(requestDoc) }),
        findOneAndUpdate: vi.fn().mockReturnValue({
          exec: () => Promise.resolve({ ...requestDoc, status: 'rejected' }),
        }),
        create: vi.fn(),
        find: vi.fn(),
      };
      const ledgerService = {
        getBalance: vi.fn(),
        adjustPending: vi.fn().mockResolvedValue({}),
        appendEntry: vi.fn(),
      };
      const delegationService = {
        canActAsApprover: vi.fn().mockResolvedValue(true),
      };
      const svc = new LeaveRequestService(
        requestModel as any,
        {} as any, // leaveTypeModel
        {} as any, // holidayModel
        {} as any, // memberModel
        {} as any, // salaryModel
        {} as any, // workspaceModel
        ledgerService as any,
        {} as any, // settingsService
        {} as any, // compOffService
        delegationService as any,
        {} as any, // eventService
        {} as any, // projectionService
        auditService as any,
        postHog as any,
      );
      return { svc, requestModel, ledgerService };
    }

    it('fires leave.request_rejected on rejectRequest success', async () => {
      const requestId = new Types.ObjectId();
      const requestDoc = {
        _id: requestId,
        workspaceId,
        teamMemberId: memberId,
        status: 'pending',
        currentLevel: 1,
        approvalChain: [{ approverUserId: userId, decision: null }],
        paidDays: 0,
      };
      const { svc } = makeRequestService(requestDoc);

      await svc.rejectRequest(
        workspaceId.toHexString(),
        requestId.toHexString(),
        userId.toHexString(),
        'Insufficient cover',
      );

      const call = auditCall('leave.request_rejected');
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.LEAVE,
        entityType: 'leave_request',
        action: 'leave.request_rejected',
        teamMemberId: memberId.toHexString(),
      });
    });
  });

  // ── CompOffRequestService — cancel ─────────────────────────────────────

  describe('CompOffRequestService', () => {
    it('fires leave.comp_off_cancelled on cancelRequest success', async () => {
      const requestId = new Types.ObjectId();
      const save = vi.fn().mockResolvedValue(undefined);
      const requestDoc = {
        _id: requestId,
        workspaceId,
        teamMemberId: memberId,
        appliedBy: { toString: () => userId.toHexString() },
        status: 'pending',
        currentLevel: 1,
        save,
      };
      const requestModel = {
        findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(requestDoc) }),
        create: vi.fn(),
        find: vi.fn(),
      };

      const svc = new CompOffRequestService(
        requestModel as any,
        {} as any, // leaveTypeModel
        {} as any, // holidayModel
        {} as any, // memberModel
        {} as any, // workspaceModel
        {} as any, // compOffService
        {} as any, // settingsService
        {} as any, // delegationService
        auditService as any,
        postHog as any,
      );
      await svc.cancelRequest(
        workspaceId.toHexString(),
        requestId.toHexString(),
        userId.toHexString(),
      );

      const call = auditCall('leave.comp_off_cancelled');
      expect(call).toBeDefined();
      expect(call[0]).toMatchObject({
        module: AppModuleEnum.LEAVE,
        entityType: 'comp_off_request',
        action: 'leave.comp_off_cancelled',
      });
    });
  });
});
