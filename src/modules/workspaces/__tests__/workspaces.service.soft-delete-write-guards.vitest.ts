/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing WorkspacesService — transitive schema
// imports would otherwise trip vitest's esbuild reflection pipeline. Mirrors
// the audit / posthog spec pattern.
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
import { WorkspacesService } from '../workspaces.service';

/**
 * Soft-delete write-path guards.
 *
 * `findAllForUser` / `getCurrentWorkspaceCount` / `findById` already exclude
 * soft-deleted workspaces. These tests cover the owner/membership-gated WRITE
 * paths that still operated by workspaceId without an `isDeleted` guard, so a
 * stale workspace id could mutate a hidden workspace. Each must now refuse with
 * NotFound and perform NO mutation.
 */
describe('WorkspacesService — soft-delete write guards', () => {
  let workspaceModel: any;
  let memberModel: any;
  let usersService: any;
  let subscriptionModel: any;
  let inviteDispatcher: any;
  let configService: any;
  let workspaceCounterService: any;
  let moduleRef: any;
  let auditService: any;
  let postHog: any;
  let revocationService: any;
  let notificationsService: any;
  let svc: WorkspacesService;

  const ownerId = new Types.ObjectId();
  const workspaceId = new Types.ObjectId();
  const memberId = new Types.ObjectId();

  // Flexible findById stub that satisfies both `.exec()` and
  // `.select(...).lean().exec()` call shapes, always resolving a soft-deleted
  // workspace.
  function deletedWorkspaceFindById() {
    const ws = { _id: workspaceId, ownerId, isDeleted: true, designations: [], name: 'Gone' };
    return {
      exec: () => Promise.resolve(ws),
      select: () => ({ lean: () => ({ exec: () => Promise.resolve(ws) }) }),
      lean: () => ({ exec: () => Promise.resolve(ws) }),
    };
  }

  beforeEach(() => {
    workspaceModel = {
      findById: vi.fn().mockReturnValue(deletedWorkspaceFindById()),
      findByIdAndUpdate: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(2) }),
    };
    memberModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      db: {
        model: vi.fn().mockReturnValue({
          findById: vi.fn().mockReturnValue({
            lean: () => ({ exec: () => Promise.resolve(null) }),
          }),
          updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
          updateMany: vi
            .fn()
            .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 0 }) }),
          countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
        }),
      },
    };
    usersService = {
      findById: vi.fn().mockResolvedValue({ name: 'Inviter', _id: ownerId }),
      findByIdentifier: vi.fn().mockResolvedValue(null),
    };
    subscriptionModel = {
      findOne: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      }),
    };
    inviteDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    configService = { get: vi.fn().mockReturnValue('https://test') };
    workspaceCounterService = {};
    moduleRef = { get: vi.fn() };
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };
    revocationService = {
      clear: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
    notificationsService = { createNotification: vi.fn().mockResolvedValue(undefined) };

    svc = new WorkspacesService(
      workspaceModel,
      memberModel,
      usersService,
      subscriptionModel,
      inviteDispatcher,
      configService,
      workspaceCounterService,
      moduleRef,
      auditService,
      postHog,
      revocationService,
      notificationsService,
      // ADR-0004 — EventEmitter2 stub for the `workspace.deleted` emit.
      { emit: vi.fn() } as any,
    );
  });

  // ── checkSeatLimit (private; reached first by inviteMember) ──────────────

  it('checkSeatLimit throws NotFound for a soft-deleted workspace', async () => {
    await expect((svc as any).checkSeatLimit(workspaceId.toHexString())).rejects.toThrow(
      'Workspace not found',
    );
  });

  it('inviteMember refuses on a soft-deleted workspace (no member row written)', async () => {
    memberModel.findOne.mockResolvedValue(null);
    await expect(
      svc.inviteMember(workspaceId.toHexString(), ownerId.toHexString(), {
        email: 'invitee@example.com',
      } as any),
    ).rejects.toThrow('Workspace not found');
    expect(inviteDispatcher.dispatch).not.toHaveBeenCalled();
  });

  // ── designation ops (all funnel through listDesignations) ────────────────

  it('listDesignations throws NotFound for a soft-deleted workspace', async () => {
    await expect(svc.listDesignations(workspaceId.toHexString())).rejects.toThrow(
      'Workspace not found',
    );
  });

  it('addDesignation refuses on a soft-deleted workspace (no $set write)', async () => {
    await expect(
      svc.addDesignation(
        workspaceId.toHexString(),
        { designation: { canonical: 'Weaver', labels: { en: 'Weaver' } } } as any,
        ownerId.toHexString(),
      ),
    ).rejects.toThrow('Workspace not found');
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('deleteDesignation refuses on a soft-deleted workspace (no $set write)', async () => {
    await expect(
      svc.deleteDesignation(workspaceId.toHexString(), 'Weaver', ownerId.toHexString()),
    ).rejects.toThrow('Workspace not found');
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  // ── invite-accept / resend (bypass RolesGuard workspace resolution) ──────

  it('joinWithToken refuses to activate a member into a soft-deleted workspace', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    memberModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          workspaceId,
          status: 'invited',
          userId: new Types.ObjectId(),
          inviteExpiry: undefined,
          linkedTeamMemberId: undefined,
          save,
        }),
    });

    await expect(svc.joinWithToken('raw-token', ownerId.toHexString())).rejects.toThrow(
      'Workspace not found',
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('acceptInviteForUser refuses to activate into a soft-deleted workspace', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    memberModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          workspaceId,
          status: 'invited',
          userId: ownerId,
          inviteExpiry: undefined,
          linkedTeamMemberId: undefined,
          save,
        }),
    });

    await expect(
      svc.acceptInviteForUser(memberId.toHexString(), ownerId.toHexString()),
    ).rejects.toThrow('Workspace not found');
    expect(save).not.toHaveBeenCalled();
  });

  it('resendInvite refuses on a soft-deleted workspace (no token rotation, no dispatch)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    memberModel.findOne.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          workspaceId,
          status: 'invited',
          inviteeIdentifier: 'invitee@example.com',
          inviteeType: 'email',
          save,
        }),
    });

    await expect(
      svc.resendInvite(workspaceId.toHexString(), memberId.toHexString(), ownerId.toHexString()),
    ).rejects.toThrow('Workspace not found');
    expect(save).not.toHaveBeenCalled();
    expect(inviteDispatcher.dispatch).not.toHaveBeenCalled();
  });

  // ── Defence in depth: settings / member writes (RolesGuard-covered too) ──
  // These routes carry a permission marker + :id, so RolesGuard already blocks
  // a deleted workspace. The service-layer guard is belt-and-suspenders for any
  // future caller that bypasses the HTTP guard pipeline. Each must refuse with
  // NotFound and perform NO write.

  const ws = () => workspaceId.toHexString();
  const actor = () => ownerId.toHexString();

  it('assertWorkspaceNotDeleted throws NotFound for a soft-deleted workspace', async () => {
    await expect((svc as any).assertWorkspaceNotDeleted(ws())).rejects.toThrow(
      'Workspace not found',
    );
  });

  it('update refuses on a soft-deleted workspace (no $set write)', async () => {
    await expect(svc.update(ws(), { name: 'X' } as any)).rejects.toThrow('Workspace not found');
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updateBranding refuses on a soft-deleted workspace', async () => {
    await expect(svc.updateBranding(ws(), { logo: 'u' } as any)).rejects.toThrow(
      'Workspace not found',
    );
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updateExportPreferences refuses on a soft-deleted workspace', async () => {
    await expect(svc.updateExportPreferences(ws(), {} as any)).rejects.toThrow(
      'Workspace not found',
    );
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updateEmployeeCodeSettings refuses on a soft-deleted workspace', async () => {
    await expect(svc.updateEmployeeCodeSettings(ws(), {} as any)).rejects.toThrow(
      'Workspace not found',
    );
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('regenerateKioskToken refuses on a soft-deleted workspace', async () => {
    await expect(svc.regenerateKioskToken(ws())).rejects.toThrow('Workspace not found');
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updateKioskSettings refuses on a soft-deleted workspace', async () => {
    await expect(svc.updateKioskSettings(ws(), {} as any)).rejects.toThrow('Workspace not found');
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updateDefaulterAlertsConfig refuses on a soft-deleted workspace', async () => {
    await expect(svc.updateDefaulterAlertsConfig(ws(), { enabled: true } as any)).rejects.toThrow(
      'Workspace not found',
    );
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updateNotificationPolicy refuses on a soft-deleted workspace', async () => {
    await expect(svc.updateNotificationPolicy(ws(), actor(), {} as any)).rejects.toThrow(
      'Workspace not found',
    );
    expect(workspaceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('removeMember refuses on a soft-deleted workspace (no revoke / no member fetch)', async () => {
    await expect(svc.removeMember(ws(), memberId.toHexString(), actor())).rejects.toThrow(
      'Workspace not found',
    );
    expect(memberModel.findById).not.toHaveBeenCalled();
    expect(revocationService.revoke).not.toHaveBeenCalled();
  });

  it('changeMemberRole refuses on a soft-deleted workspace (no role write)', async () => {
    await expect(
      svc.changeMemberRole(ws(), memberId.toHexString(), actor(), { roleId: actor() } as any),
    ).rejects.toThrow('Workspace not found');
    expect(memberModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cancelInvite refuses on a soft-deleted workspace (no status write)', async () => {
    await expect(svc.cancelInvite(ws(), memberId.toHexString())).rejects.toThrow(
      'Workspace not found',
    );
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });
});
