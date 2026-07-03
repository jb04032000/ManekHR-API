/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */

/**
 * C1 integration test — PermissionNotificationDispatcher path-read fix.
 *
 * Verifies that the dispatcher correctly reads
 * `workspace.notificationPolicy.permissionChanges` (the schema path) and
 * NOT `workspace.permissionChanges` (the broken pre-C1-fix path).
 *
 * Hard constraint: each test that asserts "should fire" MUST FAIL against the
 * old code (where the policy was read from the wrong path) and PASS after C1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators so the Workspace schema import doesn't
// require a full Mongoose / reflect-metadata bootstrap.
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

import { PermissionNotificationDispatcher } from '../permission-notification.dispatcher';

describe('PermissionNotificationDispatcher — C1 policy path fix', () => {
  let notificationsService: { createNotification: ReturnType<typeof vi.fn> };
  let mailService: { sendPermissionUpdateEmail: ReturnType<typeof vi.fn> };
  let smsService: { sendDltSms: ReturnType<typeof vi.fn> };
  let userDevicesService: { pushUser: ReturnType<typeof vi.fn> };
  let workspaceModel: { findById: ReturnType<typeof vi.fn> };
  let dispatcher: PermissionNotificationDispatcher;

  const baseArgs = {
    workspaceId: 'ws-001',
    recipientUserId: 'user-001',
    affectedMemberName: 'Test Member',
    affectedMemberId: 'member-001',
    changeKind: 'overrides_updated' as const,
    diffSummary: 'added view on salary',
  };

  beforeEach(() => {
    notificationsService = { createNotification: vi.fn().mockResolvedValue(undefined) };
    mailService = { sendPermissionUpdateEmail: vi.fn().mockResolvedValue(undefined) };
    smsService = { sendDltSms: vi.fn().mockResolvedValue(undefined) };
    userDevicesService = { pushUser: vi.fn().mockResolvedValue(undefined) };
    workspaceModel = { findById: vi.fn() };

    dispatcher = new PermissionNotificationDispatcher(
      notificationsService as any,
      mailService as any,
      smsService as any,
      userDevicesService as any,
      workspaceModel as any,
    );
  });

  // ── Policy at correct nesting path (schema-compliant shape) ───────────────

  it('fires in-app when notificationPolicy.permissionChanges.enabled=true and inApp=true', async () => {
    // This workspace has the policy at the CORRECT path.
    // Pre-C1-fix code reads workspace.permissionChanges (undefined) → short-circuits.
    // Post-C1-fix code reads workspace.notificationPolicy.permissionChanges → fires.
    const workspace = {
      name: 'Test WS',
      notificationPolicy: {
        permissionChanges: {
          enabled: true,
          channels: { inApp: true, email: false, sms: false },
        },
      },
    };

    const result = await dispatcher.dispatch({ ...baseArgs, workspace: workspace as any });

    expect(result).toEqual({ inApp: true, email: false, sms: false });
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(1);
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      'ws-001',
      expect.objectContaining({
        recipientId: 'user-001',
        type: 'info',
        title: 'Your permissions were updated',
      }),
    );
    expect(mailService.sendPermissionUpdateEmail).not.toHaveBeenCalled();
    expect(smsService.sendDltSms).not.toHaveBeenCalled();
  });

  it('short-circuits and fires nothing when policy.enabled=false', async () => {
    const workspace = {
      name: 'Test WS',
      notificationPolicy: {
        permissionChanges: {
          enabled: false,
          channels: { inApp: true, email: true, sms: true },
        },
      },
    };

    const result = await dispatcher.dispatch({ ...baseArgs, workspace: workspace as any });

    expect(result).toEqual({ inApp: false, email: false, sms: false });
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
    expect(mailService.sendPermissionUpdateEmail).not.toHaveBeenCalled();
    expect(smsService.sendDltSms).not.toHaveBeenCalled();
  });

  it('short-circuits gracefully when notificationPolicy field is entirely absent', async () => {
    // Simulates a workspace document that was created before the
    // notificationPolicy field was added to the schema.
    const workspace = { name: 'Legacy WS' };

    const result = await dispatcher.dispatch({ ...baseArgs, workspace: workspace as any });

    expect(result).toEqual({ inApp: false, email: false, sms: false });
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
  });

  it('falls back to DB fetch when workspace arg is omitted, and uses the correct path', async () => {
    const dbWorkspace = {
      name: 'Fetched WS',
      notificationPolicy: {
        permissionChanges: {
          enabled: true,
          channels: { inApp: true, email: false, sms: false },
        },
      },
    };
    workspaceModel.findById.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(dbWorkspace) }),
    });

    const result = await dispatcher.dispatch(baseArgs); // no workspace pre-loaded

    expect(workspaceModel.findById).toHaveBeenCalledWith('ws-001');
    expect(result).toEqual({ inApp: true, email: false, sms: false });
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(1);
  });

  it('fires email channel when enabled and recipientEmail is present', async () => {
    const workspace = {
      name: 'Test WS',
      notificationPolicy: {
        permissionChanges: {
          enabled: true,
          channels: { inApp: false, email: true, sms: false },
        },
      },
    };

    const result = await dispatcher.dispatch({
      ...baseArgs,
      workspace: workspace as any,
      recipientEmail: 'member@example.com',
      actorName: 'HR Manager',
    });

    expect(result).toEqual({ inApp: false, email: true, sms: false });
    expect(mailService.sendPermissionUpdateEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'member@example.com',
        workspaceName: 'Test WS',
        actorName: 'HR Manager',
        changeKind: 'overrides_updated',
      }),
    );
  });

  it('defaults actorName to "An admin" when not passed', async () => {
    const workspace = {
      name: 'Test WS',
      notificationPolicy: {
        permissionChanges: {
          enabled: true,
          channels: { inApp: false, email: true, sms: false },
        },
      },
    };

    await dispatcher.dispatch({
      ...baseArgs,
      workspace: workspace as any,
      recipientEmail: 'member@example.com',
      // actorName deliberately omitted
    });

    expect(mailService.sendPermissionUpdateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ actorName: 'An admin' }),
    );
  });
});
