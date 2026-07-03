/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
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
import { LeaveService } from '../leave.service';
import { LeaveSettingsService } from '../leave-settings.service';
import { LeaveDelegationService } from '../leave-delegation.service';
import { CompOffRequestService } from '../comp-off-request.service';
import { LeaveAccrualCron } from '../leave-accrual.cron';
import { LeaveMaintenanceCron } from '../leave-maintenance.cron';

/**
 * PostHog server-side capture coverage for Phase 5 W4.
 *
 * Asserts that the canonical `leave.*` snake_case events fire on the success
 * paths of the leave write surface and the 3 leave cron handlers. Mirrors
 * `team.service.posthog.vitest.ts`.
 *
 * PostHog is mocked — no real network calls. The real wrapper
 * (`PostHogService.capture`) swallows client errors internally, so a flaky
 * PostHog backend never breaks a leave flow.
 */
describe('Leave module — PostHog capture (Phase 5 W4)', () => {
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };

  const workspaceId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const leaveTypeId = new Types.ObjectId();

  /** Find the PostHog capture call for a given event name. */
  function captureCall(event: string): unknown[] | undefined {
    return postHog.capture.mock.calls.find((c: any[]) => c[0].event === event) as
      | unknown[]
      | undefined;
  }

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };
  });

  // ── leave.leave_type_created ───────────────────────────────────────────

  it('fires leave.leave_type_created on createLeaveType success', async () => {
    const model = {
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      exists: vi.fn().mockResolvedValue(null),
      countDocuments: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ _id: leaveTypeId, code: 'SL' }),
    };
    const svc = new LeaveService(model as any, auditService as any, postHog as any);
    await svc.createLeaveType(
      workspaceId.toHexString(),
      { code: 'sl', labels: { en: 'Sick Leave' }, color: '#000', isPaid: true, unit: 'day' } as any,
      userId.toHexString(),
    );

    const call = captureCall('leave.leave_type_created');
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: userId.toHexString(),
      event: 'leave.leave_type_created',
      properties: { workspaceId: workspaceId.toHexString(), code: 'SL' },
    });
  });

  // ── leave.settings_updated ─────────────────────────────────────────────

  it('fires leave.settings_updated on updateSettings success', async () => {
    const model = {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
      }),
      create: vi.fn(),
    };
    const svc = new LeaveSettingsService(model as any, auditService as any, postHog as any);
    await svc.updateSettings(
      workspaceId.toHexString(),
      {
        approverUserIds: [userId.toHexString()],
        sandwichLeave: false,
        retroMaxDaysBack: 14,
        maxAttachmentsPerRequest: 2,
      },
      userId.toHexString(),
    );

    const call = captureCall('leave.settings_updated');
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: userId.toHexString(),
      properties: { workspaceId: workspaceId.toHexString(), approverCount: 1 },
    });
  });

  // ── leave.delegation_created ───────────────────────────────────────────

  it('fires leave.delegation_created on createDelegation success', async () => {
    const delegationId = new Types.ObjectId();
    const toUserId = new Types.ObjectId();
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
      startsOn: '2026-07-01',
      endsOn: '2026-07-15',
    });

    const call = captureCall('leave.delegation_created');
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: userId.toHexString(),
      event: 'leave.delegation_created',
      properties: { workspaceId: workspaceId.toHexString(), toUserId: toUserId.toHexString() },
    });
  });

  // ── leave.comp_off_cancelled ───────────────────────────────────────────

  it('fires leave.comp_off_cancelled on cancelRequest success', async () => {
    const requestId = new Types.ObjectId();
    const requestDoc = {
      _id: requestId,
      workspaceId,
      teamMemberId: memberId,
      appliedBy: { toString: () => userId.toHexString() },
      status: 'pending',
      currentLevel: 1,
      save: vi.fn().mockResolvedValue(undefined),
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

    const call = captureCall('leave.comp_off_cancelled');
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: userId.toHexString(),
      event: 'leave.comp_off_cancelled',
      properties: {
        workspaceId: workspaceId.toHexString(),
        compOffRequestId: requestId.toHexString(),
      },
    });
  });

  // ── Cron-completion events ─────────────────────────────────────────────

  it('fires leave.accrual_cron_completed on LeaveAccrualCron.run success', async () => {
    const accrualService = {
      accrueAllWorkspaces: vi.fn().mockResolvedValue({
        workspacesScanned: 4,
        membersScanned: 40,
        entriesPosted: 12,
        errors: [],
      }),
    };
    const cron = new LeaveAccrualCron(accrualService as any, postHog as any);
    await cron.run();

    const call = captureCall('leave.accrual_cron_completed');
    expect(call).toBeDefined();
    expect(call[0].distinctId).toBe('system:leave-cron');
    expect(call[0].properties).toMatchObject({
      workspacesScanned: 4,
      membersScanned: 40,
      entriesPosted: 12,
      errors: 0,
    });
  });

  it('fires leave.comp_off_expiry_cron_completed on runCompOffExpiry success', async () => {
    const compOffService = {
      expireCompOffLots: vi.fn().mockResolvedValue({
        lotsExpired: 3,
        daysExpired: 5,
        errors: [],
      }),
    };
    const cron = new LeaveMaintenanceCron(
      compOffService as any,
      {} as any, // yearEndService
      postHog as any,
    );
    await cron.runCompOffExpiry();

    const call = captureCall('leave.comp_off_expiry_cron_completed');
    expect(call).toBeDefined();
    expect(call[0].distinctId).toBe('system:leave-cron');
    expect(call[0].properties).toMatchObject({ lotsExpired: 3, daysExpired: 5, errors: 0 });
  });

  it('does NOT fire a PostHog event when the accrual cron handler throws', async () => {
    const accrualService = {
      accrueAllWorkspaces: vi.fn().mockRejectedValue(new Error('accrual engine down')),
    };
    const cron = new LeaveAccrualCron(accrualService as any, postHog as any);
    // The cron swallows its own error (never rethrows) — the run resolves.
    await expect(cron.run()).resolves.toBeUndefined();
    expect(captureCall('leave.accrual_cron_completed')).toBeUndefined();
  });
});
