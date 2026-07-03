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
import { WorkspacesService } from '../workspaces.service';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * Audit fire-and-forget coverage for Phase 5 W5 workspace events.
 *
 * Verifies:
 *   - Each meaningful write fires `auditService.logEvent` with
 *     `module: AppModule.WORKSPACES` + the expected action string.
 *   - The actor / workspace / entity fields normalise via the helper
 *     (ObjectId or string both accepted).
 *   - Audit failures are swallowed and never break the caller.
 */
describe('WorkspacesService — audit fire-and-forget (Phase 5 W5)', () => {
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
  const memberId = new Types.ObjectId();

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    workspaceModel = {
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      findByIdAndDelete: vi.fn(),
      countDocuments: vi.fn(),
      create: vi.fn(),
    };
    // Non-deleted workspace for the `assertWorkspaceNotDeleted` pre-check that
    // now fronts the settings / member write paths (helper reads
    // `findById(id).select('isDeleted').lean().exec()`).
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
      findById: vi.fn().mockResolvedValue({ name: 'Inviter' }),
      findByIdentifier: vi.fn(),
    };
    subscriptionModel = {
      findOne: vi.fn().mockReturnValue({ select: () => ({ lean: () => ({ exec: () => null }) }) }),
    };
    inviteDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    configService = { get: vi.fn().mockReturnValue('https://test') };
    workspaceCounterService = {
      getCurrent: vi.fn().mockResolvedValue(0),
      setCounter: vi.fn().mockResolvedValue(undefined),
    };
    moduleRef = { get: vi.fn() };
    postHog = { capture: vi.fn(), identify: vi.fn() };

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
      { dispatch: vi.fn().mockResolvedValue(undefined) } as any, // notifications
      { emit: vi.fn() } as any, // EventEmitter2 (ADR-0004 workspace.deleted)
    );
  });

  // ── Direct helper coverage ─────────────────────────────────────────────

  it('auditWorkspaceEvent normalises ObjectId actorId/workspaceId via String()', () => {
    svc.auditWorkspaceEvent({
      action: 'workspace.workspace_created',
      workspaceId,
      actorId: ownerId,
    });

    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    const arg = auditService.logEvent.mock.calls[0][0];
    expect(arg.module).toBe(AppModule.WORKSPACES);
    expect(arg.action).toBe('workspace.workspace_created');
    expect(arg.workspaceId).toBe(workspaceId.toHexString());
    expect(arg.actorId).toBe(ownerId.toHexString());
    expect(arg.entityType).toBe('workspace');
  });

  it('auditWorkspaceEvent accepts null workspaceId for tenant-agnostic events', () => {
    svc.auditWorkspaceEvent({
      action: 'workspace.workspace_deleted',
      workspaceId: null,
      actorId: ownerId,
      entityId: workspaceId,
    });

    const arg = auditService.logEvent.mock.calls[0][0];
    expect(arg.workspaceId).toBeNull();
    expect(arg.entityId).toBe(workspaceId.toHexString());
  });

  it('auditWorkspaceEvent passes meta + actorNameSnapshot through', () => {
    svc.auditWorkspaceEvent({
      action: 'workspace.member_invited',
      workspaceId,
      actorId: ownerId,
      actorNameSnapshot: 'Inviter Person',
      meta: { inviteeType: 'email', inviteeIdentifier: 'a@b.com' },
    });

    const arg = auditService.logEvent.mock.calls[0][0];
    expect(arg.actorNameSnapshot).toBe('Inviter Person');
    expect(arg.meta).toEqual({ inviteeType: 'email', inviteeIdentifier: 'a@b.com' });
  });

  // ── Write-path coverage ────────────────────────────────────────────────

  it('fires workspace.workspace_updated on update success', async () => {
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () => Promise.resolve({ _id: workspaceId, ownerId, name: 'WS' }),
    });

    await svc.update(workspaceId.toHexString(), { name: 'New Name' });

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'workspace.workspace_updated',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      module: AppModule.WORKSPACES,
      action: 'workspace.workspace_updated',
    });
    expect(call[0].meta.fieldsChanged).toEqual(['name']);
  });

  it('fires workspace.member_role_changed on changeMemberRole success', async () => {
    memberModel.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          workspaceId,
          userId: ownerId,
          roleId: new Types.ObjectId(),
        }),
    });

    await svc.changeMemberRole(
      workspaceId.toHexString(),
      memberId.toHexString(),
      ownerId.toHexString(),
      { roleId: new Types.ObjectId().toHexString() },
    );

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'workspace.member_role_changed',
    );
    expect(call).toBeDefined();
    expect(call[0].entityType).toBe('workspace_member');
  });

  it('fires workspace.branding_updated on updateBranding success', async () => {
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: workspaceId,
          ownerId,
          branding: { logo: 'url' },
        }),
    });

    await svc.updateBranding(workspaceId.toHexString(), { logo: 'url' });

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'workspace.branding_updated',
    );
    expect(call).toBeDefined();
    expect(call[0].meta.fieldsChanged).toEqual(['logo']);
  });

  it('fires workspace.export_preferences_updated on updateExportPreferences success', async () => {
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: workspaceId,
          ownerId,
          exportPreferences: { includeHeaderLogo: true },
        }),
    });

    await svc.updateExportPreferences(workspaceId.toHexString(), {
      includeHeaderLogo: true,
    });

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'workspace.export_preferences_updated',
    );
    expect(call).toBeDefined();
  });

  it('fires workspace.kiosk_token_rotated on regenerateKioskToken success', async () => {
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: workspaceId,
          ownerId,
          kioskTokenHash: 'hashed-secret',
          kioskTokenRotatedAt: new Date(),
        }),
    });

    const r = await svc.regenerateKioskToken(workspaceId.toHexString());
    expect(r.secret).toBeTruthy();
    expect(r.rotatedAt).toBeInstanceOf(Date);

    const call = auditService.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'workspace.kiosk_token_rotated',
    );
    expect(call).toBeDefined();
  });

  // ── Resilience ─────────────────────────────────────────────────────────

  it('audit failure is swallowed and does NOT break caller', async () => {
    auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: workspaceId,
          ownerId,
          branding: { logo: 'x' },
        }),
    });

    // Caller's primary op must still resolve normally.
    await expect(
      svc.updateBranding(workspaceId.toHexString(), { logo: 'x' }),
    ).resolves.toBeDefined();

    // Audit was attempted (and rejected internally) — caller never sees it.
    expect(auditService.logEvent).toHaveBeenCalled();
  });
});
