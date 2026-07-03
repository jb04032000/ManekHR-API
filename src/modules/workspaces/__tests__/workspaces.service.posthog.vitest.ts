/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing WorkspacesService — the
// transitive schema imports would otherwise trip vitest's esbuild reflection
// pipeline. Mirrors the audit-spec pattern.
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
 * PostHog server-side capture coverage for Phase 5 W6.
 *
 * Asserts that the canonical `workspace.*` events fire on the success paths of
 * the workspace surface:
 *   - workspace_created (`identify` + `capture` with workspaceId + tier)
 *   - member_invited (with inviteeType)
 *   - member_role_changed (with workspaceId + memberId + roleId)
 *   - branding_updated (with fieldsChanged)
 *   - kiosk_token_rotated (with workspaceId)
 *   - workspace_deleted (with workspaceId + name)
 *
 * PostHog is mocked — no real network calls. The real wrapper
 * (`PostHogService.capture`) swallows client errors internally, so a flaky
 * PostHog backend never breaks a workspace flow.
 */
describe('WorkspacesService — PostHog capture (Phase 5 W6)', () => {
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
  const planId = new Types.ObjectId();

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };
    workspaceModel = {
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      findByIdAndDelete: vi.fn(),
      countDocuments: vi.fn(),
      create: vi.fn(),
      // recomputeHasWorkspace() (called by remove/restore) probes for a live
      // owned workspace; default null = none left.
      exists: vi.fn().mockResolvedValue(null),
    };
    // Make `new this.workspaceModel({...})` work — return an object with a
    // `save()` and a fixed `_id`. WorkspacesService's create flow saves the
    // workspace, then uses `workspace._id` for downstream identify+capture.
    const newWorkspace: any = function (props: any) {
      return {
        ...props,
        _id: workspaceId,
        save: vi.fn().mockResolvedValue(undefined),
      };
    };
    Object.assign(newWorkspace, workspaceModel);
    workspaceModel = newWorkspace;

    // Default: a non-deleted workspace for the `assertWorkspaceNotDeleted`
    // pre-check that now fronts the settings / member write paths (helper reads
    // `findById(id).select('isDeleted').lean().exec()`). Tests that exercise
    // non-guarded flows override findById for their own call shape.
    workspaceModel.findById.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve({ _id: workspaceId, ownerId, isDeleted: false }),
        }),
      }),
    });

    // `create` → `generateUniqueWorkspaceCode` reads
    // `findOne({ workspaceCode }).select('_id').lean().exec()` to check for a
    // collision; resolve null (no clash) so a unique code is generated. The mock
    // predated the workspace-code generation being added to `create`.
    workspaceModel.findOne = vi.fn().mockReturnValue({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
    });

    const newMember: any = function (props: any) {
      return {
        ...props,
        _id: memberId,
        save: vi.fn().mockResolvedValue(undefined),
      };
    };
    Object.assign(newMember, {
      findById: vi.fn(),
      findOne: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      countDocuments: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue(undefined),
      db: {
        // Default: any cross-model lookup (e.g. TeamMember cascade) resolves to
        // a no-op deleteMany so unrelated tests don't trip over the cascade.
        model: vi.fn().mockReturnValue({
          deleteMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ deletedCount: 0 }) }),
        }),
      },
    });
    memberModel = newMember;

    usersService = {
      findById: vi.fn().mockResolvedValue({ name: 'Inviter', _id: ownerId }),
      findByIdentifier: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    };
    subscriptionModel = {
      findOne: vi.fn().mockReturnValue({
        sort: () => ({ exec: () => Promise.resolve(null) }),
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve({
                appliedEntitlements: { maxWorkspaces: -1, maxMembersPerWorkspace: -1 },
                planId,
                status: 'active',
              }),
          }),
        }),
      }),
    };
    inviteDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    configService = { get: vi.fn().mockReturnValue('https://test') };
    workspaceCounterService = {
      getCurrent: vi.fn().mockResolvedValue(0),
      setCounter: vi.fn().mockResolvedValue(undefined),
    };
    moduleRef = {
      get: vi.fn().mockReturnValue({
        create: vi.fn(),
        grantTrialCreditsForWorkspace: vi.fn().mockResolvedValue({ granted: false }),
      }),
    };

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

  // ── workspace_created — identify + capture with tier ──────────────────

  it('fires identify + workspace.workspace_created on create success', async () => {
    await svc.create(ownerId.toHexString(), {
      name: 'New WS',
    });

    // identify must fire so workspaceId binds to user funnels
    expect(postHog.identify).toHaveBeenCalledTimes(1);
    expect(postHog.identify.mock.calls[0][0]).toMatchObject({
      distinctId: ownerId.toHexString(),
      properties: { workspaceId: workspaceId.toHexString() },
    });

    const created = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'workspace.workspace_created',
    );
    expect(created).toBeDefined();
    expect(created[0]).toMatchObject({
      distinctId: ownerId.toHexString(),
      event: 'workspace.workspace_created',
      properties: { workspaceId: workspaceId.toHexString(), tier: planId.toHexString() },
    });
  });

  // ── member_invited ─────────────────────────────────────────────────────

  it('fires workspace.member_invited with inviteeType email on inviteMember success', async () => {
    memberModel.findOne.mockResolvedValue(null);
    // checkSeatLimit calls memberModel.countDocuments(...).exec()
    memberModel.countDocuments.mockReturnValue({
      exec: () => Promise.resolve(0),
    });
    workspaceModel.findById.mockReturnValue({
      exec: () => Promise.resolve({ _id: workspaceId, name: 'WS', ownerId }),
    });

    await svc.inviteMember(workspaceId.toHexString(), ownerId.toHexString(), {
      email: 'invitee@example.com',
      roleId: undefined,
    });

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'workspace.member_invited',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: ownerId.toHexString(),
      event: 'workspace.member_invited',
      properties: { workspaceId: workspaceId.toHexString(), inviteeType: 'email' },
    });
  });

  // ── member_role_changed ────────────────────────────────────────────────

  it('fires workspace.member_role_changed on changeMemberRole success', async () => {
    const newRoleId = new Types.ObjectId();
    memberModel.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: memberId,
          workspaceId,
          userId: ownerId,
          roleId: newRoleId,
        }),
    });

    await svc.changeMemberRole(
      workspaceId.toHexString(),
      memberId.toHexString(),
      ownerId.toHexString(),
      { roleId: newRoleId.toHexString() },
    );

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'workspace.member_role_changed',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      event: 'workspace.member_role_changed',
      properties: {
        workspaceId: workspaceId.toHexString(),
        memberId: memberId.toHexString(),
        roleId: newRoleId.toHexString(),
      },
    });
  });

  // ── branding_updated ───────────────────────────────────────────────────

  it('fires workspace.branding_updated with fieldsChanged on updateBranding success', async () => {
    workspaceModel.findByIdAndUpdate.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: workspaceId,
          ownerId,
          branding: { logo: 'url' },
        }),
    });

    await svc.updateBranding(workspaceId.toHexString(), { logo: 'url' });

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'workspace.branding_updated',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: ownerId.toHexString(),
      event: 'workspace.branding_updated',
      properties: {
        workspaceId: workspaceId.toHexString(),
        fieldsChanged: ['logo'],
      },
    });
  });

  // ── kiosk_token_rotated ────────────────────────────────────────────────

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

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'workspace.kiosk_token_rotated',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: ownerId.toHexString(),
      event: 'workspace.kiosk_token_rotated',
      properties: { workspaceId: workspaceId.toHexString() },
    });
  });

  // ── workspace_deleted ──────────────────────────────────────────────────

  it('fires workspace.workspace_deleted on remove success', async () => {
    workspaceModel.findById.mockReturnValue({
      exec: () =>
        Promise.resolve({
          _id: workspaceId,
          ownerId,
          name: 'Doomed WS',
        }),
    });
    workspaceModel.countDocuments.mockReturnValue({
      exec: () => Promise.resolve(2),
    });
    workspaceModel.updateOne = vi
      .fn()
      .mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) });

    await svc.remove(workspaceId.toHexString(), ownerId.toHexString());

    const call = postHog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'workspace.workspace_deleted',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      distinctId: ownerId.toHexString(),
      event: 'workspace.workspace_deleted',
      properties: { workspaceId: workspaceId.toHexString(), name: 'Doomed WS' },
    });
  });

  it('soft-deletes the workspace and leaves members untouched on remove', async () => {
    const updateOne = vi.fn().mockReturnValue({ exec: () => Promise.resolve({ matchedCount: 1 }) });
    workspaceModel.findById.mockReturnValue({
      exec: () => Promise.resolve({ _id: workspaceId, ownerId, name: 'Doomed WS' }),
    });
    workspaceModel.countDocuments.mockReturnValue({ exec: () => Promise.resolve(2) });
    workspaceModel.updateOne = updateOne;

    // A TeamMember spy that must NOT be called (no erase on user delete).
    const teamMemberDeleteMany = vi.fn();
    memberModel.db.model.mockReturnValue({ deleteMany: teamMemberDeleteMany });

    await svc.remove(workspaceId.toHexString(), ownerId.toHexString());

    const filter = updateOne.mock.calls[0][0];
    const update = updateOne.mock.calls[0][1];
    expect(String(filter._id)).toBe(workspaceId.toHexString());
    expect(update.$set.isDeleted).toBe(true);
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    expect(String(update.$set.deletedBy)).toBe(ownerId.toHexString());

    expect(workspaceModel.findByIdAndDelete).not.toHaveBeenCalled();
    expect(teamMemberDeleteMany).not.toHaveBeenCalled();
  });

  it('getCurrentWorkspaceCount counts only non-deleted workspaces', async () => {
    const countDocuments = vi.fn().mockResolvedValue(1);
    workspaceModel.countDocuments = countDocuments;
    workspaceModel.findById.mockReturnValue({ exec: () => Promise.resolve(null) });

    try {
      await svc.create(ownerId.toHexString(), { name: 'X' });
    } catch {
      // create may proceed or throw; we only assert the count filter shape.
    }

    const calledWith = countDocuments.mock.calls.map((c) => c[0]);
    expect(
      calledWith.some(
        (f) => f && String(f.ownerId) === ownerId.toHexString() && f.isDeleted?.$ne === true,
      ),
    ).toBe(true);
  });

  it('findAllForUser excludes soft-deleted owned workspaces', async () => {
    const find = vi.fn().mockReturnValue({
      populate: () => ({ exec: () => Promise.resolve([]) }),
    });
    workspaceModel.find = find;
    memberModel.find = vi.fn().mockReturnValue({
      populate: () => ({ exec: () => Promise.resolve([]) }),
    });

    await svc.findAllForUser(ownerId.toHexString());

    const ownedFilter = find.mock.calls[0][0];
    expect(String(ownedFilter.ownerId)).toBe(ownerId.toHexString());
    expect(ownedFilter.isDeleted?.$ne).toBe(true);
  });

  it('findById throws NotFound for a soft-deleted workspace', async () => {
    workspaceModel.findById.mockReturnValue({
      populate: () => ({
        exec: () =>
          Promise.resolve({
            _id: workspaceId,
            isDeleted: true,
            ownerId: { isActive: true, name: 'Owner' },
          }),
      }),
    });

    await expect(svc.findById(workspaceId.toHexString())).rejects.toThrow('Workspace not found');
  });
});
