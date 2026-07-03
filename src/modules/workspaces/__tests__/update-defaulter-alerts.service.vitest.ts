/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing WorkspacesService — the
// transitive schema imports (Workspace, WorkspaceMember, Subscription) would
// otherwise trip vitest's esbuild "Cannot determine type" reflection error.
// We inject all Models as plain mocks; no Mongoose runtime is involved.
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

vi.mock('bcryptjs', () => ({
  hash: vi.fn().mockResolvedValue('hashed-secret'),
  default: { hash: vi.fn().mockResolvedValue('hashed-secret') },
}));

import { Types } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { WorkspacesService } from '../workspaces.service';

/**
 * Unit tests for WorkspacesService.updateDefaulterAlertsConfig.
 *
 * Verifies:
 *  - calls findByIdAndUpdate with the correct path/operator and returns the
 *    updated workspace document.
 *  - throws NotFoundException when findByIdAndUpdate resolves null.
 *  - fires an audit event with action 'workspace.defaulter_alerts_config_updated'
 *    and meta { enabled }.
 */
describe('WorkspacesService.updateDefaulterAlertsConfig', () => {
  let workspaceModel: any;
  let memberModel: any;
  let usersService: any;
  let subscriptionModel: any;
  let inviteDispatcher: any;
  let configService: any;
  let workspaceCounterService: any;
  let moduleRef: any;
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };
  let svc: WorkspacesService;

  const ownerId = new Types.ObjectId();
  const workspaceId = new Types.ObjectId();

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };

    workspaceModel = {
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      findByIdAndDelete: vi.fn(),
      countDocuments: vi.fn(),
      create: vi.fn(),
    };
    // `updateDefaulterAlertsConfig` calls `assertWorkspaceNotDeleted` first, which
    // reads `findById(id).select('isDeleted').lean().exec()`. Provide the chain so
    // the guard sees a non-deleted workspace and proceeds (the mock predated the
    // guard being added to this method in an earlier pass).
    workspaceModel.findById.mockReturnValue({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve({ isDeleted: false }) }) }),
    });
    memberModel = {
      findById: vi.fn(),
      findOne: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      countDocuments: vi.fn(),
      deleteMany: vi.fn(),
      db: { model: vi.fn() },
    };
    usersService = {
      findById: vi.fn().mockResolvedValue({ name: 'Owner' }),
      findByIdentifier: vi.fn(),
    };
    subscriptionModel = {
      findOne: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => null }) }),
      }),
    };
    inviteDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    configService = { get: vi.fn().mockReturnValue('https://test') };
    workspaceCounterService = {
      getCurrent: vi.fn().mockResolvedValue(0),
      setCounter: vi.fn().mockResolvedValue(undefined),
    };
    moduleRef = { get: vi.fn() };

    svc = new WorkspacesService(
      workspaceModel,
      memberModel,
      usersService,
      subscriptionModel,
      inviteDispatcher,
      configService,
      workspaceCounterService,
      moduleRef,
      auditService as any,
      postHog as any,
      { revoke: vi.fn().mockResolvedValue(undefined) } as any,
      { sendNotification: vi.fn().mockResolvedValue(undefined) } as any,
      { emit: vi.fn() } as any, // EventEmitter2 (ADR-0004 workspace.deleted)
    );
  });

  const validDto = {
    enabled: true,
    channels: { inApp: true, email: false },
    recipients: { mode: 'managers' as const, specificPeople: [] },
  };

  it('calls findByIdAndUpdate with $set on attendanceSettings.defaulterAlerts and returns workspace', async () => {
    const updatedWorkspace = {
      _id: workspaceId,
      ownerId,
      attendanceSettings: { defaulterAlerts: validDto },
    };

    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(updatedWorkspace),
    });

    const result = await svc.updateDefaulterAlertsConfig(workspaceId.toHexString(), validDto);

    expect(workspaceModel.findByIdAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ toHexString: expect.any(Function) }),
      { $set: { 'attendanceSettings.defaulterAlerts': validDto } },
      { new: true },
    );
    expect(result).toBe(updatedWorkspace);
  });

  it('throws NotFoundException when workspace is not found', async () => {
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    await expect(
      svc.updateDefaulterAlertsConfig(workspaceId.toHexString(), validDto as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('fires audit event workspace.defaulter_alerts_config_updated with meta { enabled }', async () => {
    const updatedWorkspace = {
      _id: workspaceId,
      ownerId,
      attendanceSettings: { defaulterAlerts: validDto },
    };

    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () => Promise.resolve(updatedWorkspace),
    });

    await svc.updateDefaulterAlertsConfig(workspaceId.toHexString(), validDto);

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'workspace.defaulter_alerts_config_updated',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      action: 'workspace.defaulter_alerts_config_updated',
      meta: { enabled: validDto.enabled },
    });
  });
});
