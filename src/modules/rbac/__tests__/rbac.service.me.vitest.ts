/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing RbacService — transitive
// schema imports would otherwise trip vitest's reflect-metadata pipeline.
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
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RbacService } from '../rbac.service';

describe('RbacService.getMyPermissions', () => {
  let roleModel: any;
  let workspaceModel: any;
  let memberModel: any;
  let teamMemberModel: any;
  let svc: RbacService;

  const ownerId = new Types.ObjectId();
  const memberUserId = new Types.ObjectId();
  const workspaceId = new Types.ObjectId();
  const roleId = new Types.ObjectId();

  beforeEach(() => {
    roleModel = { findById: vi.fn() };
    workspaceModel = { findById: vi.fn() };
    memberModel = { findOne: vi.fn() };
    teamMemberModel = { aggregate: vi.fn(), countDocuments: vi.fn(), findOne: vi.fn() };

    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) } as any;
    svc = new RbacService(roleModel, workspaceModel, memberModel, teamMemberModel, auditService);

    // Default: no per-member overrides. Tests exercising the override merge
    // re-stub teamMemberModel.findOne explicitly.
    teamMemberFindOne(null);
  });

  function workspaceFindById(workspace: any) {
    workspaceModel.findById.mockReturnValue({
      exec: vi.fn().mockResolvedValue(workspace),
    });
  }

  function memberFindOne(member: any) {
    memberModel.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(member),
    });
  }

  function roleFindById(role: any) {
    roleModel.findById.mockReturnValue({
      // 2026-05-22: service now calls `.lean().exec()` on role lookup so the
      // hash input shape matches PermissionVersionInterceptor's lean fetch.
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(role),
      }),
      exec: vi.fn().mockResolvedValue(role),
    });
  }

  function teamMemberFindOne(teamMember: any) {
    teamMemberModel.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(teamMember),
        }),
      }),
    });
  }

  it('returns isOwner=true with empty permissions when caller is workspace owner', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });

    const result = await svc.getMyPermissions(workspaceId.toString(), ownerId.toString());

    expect(result.isOwner).toBe(true);
    expect(result.role).toBeNull();
    expect(result.permissions).toEqual([]);
    expect(result.paths).toEqual([]);
    // Owner short-circuits — no member lookup
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when workspace does not exist', async () => {
    workspaceFindById(null);

    await expect(
      svc.getMyPermissions(workspaceId.toString(), ownerId.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException when caller has no membership', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null);

    await expect(
      svc.getMyPermissions(workspaceId.toString(), memberUserId.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns role=null permissions=[] when member has no roleId assigned', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId: null });

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    // Phase 2.3 added `permissionVersion` to every getMyPermissions return path.
    // Use toMatchObject so the test stays focused on the no-roleId behaviour
    // and doesn't break on additive shape changes.
    expect(result).toMatchObject({
      isOwner: false,
      teamMemberId: null,
      role: null,
      permissions: [],
      paths: [],
    });
    expect(typeof result.permissionVersion).toBe('string');
  });

  it('returns role=null when assigned role has been deleted', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId });
    roleFindById(null);

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    expect(result.role).toBeNull();
    expect(result.permissions).toEqual([]);
  });

  it('returns role + permissions when membership + role resolve cleanly', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId });
    roleFindById({
      _id: roleId,
      name: 'Manager',
      isSystem: false,
      permissions: [
        { module: 'attendance', actions: ['view', 'mark', 'edit'] },
        { module: 'team', actions: ['view'] },
      ],
    });

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    expect(result.isOwner).toBe(false);
    expect(result.role).toEqual({
      id: roleId.toString(),
      name: 'Manager',
      isSystem: false,
      selfProfileEdit: 'allow',
    });
    expect(result.permissions).toEqual([
      { module: 'attendance', actions: ['view', 'mark', 'edit'], actionScopes: undefined },
      { module: 'team', actions: ['view'], actionScopes: undefined },
    ]);
  });

  it('surfaces the caller teamMemberId and the role selfProfileEdit posture', async () => {
    const teamMemberId = new Types.ObjectId();
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId });
    roleFindById({
      _id: roleId,
      name: 'Manager',
      isSystem: true,
      selfProfileEdit: 'block',
      permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
    });
    teamMemberFindOne({ _id: teamMemberId, permissionOverrides: [] });

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    expect(result.teamMemberId).toBe(teamMemberId.toString());
    expect(result.role?.selfProfileEdit).toBe('block');
  });

  it('merges per-member permission overrides on top of the role bundle', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId });
    roleFindById({
      _id: roleId,
      name: 'Member',
      isSystem: true,
      permissions: [
        { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
        { module: 'team', actions: ['view', 'edit'], actionScopes: ['all', 'all'] },
      ],
    });
    // deny team.edit, allow salary.view (self) — both must surface so the web
    // <Can> state matches what RolesGuard enforces.
    teamMemberFindOne({
      permissionOverrides: [
        { module: 'team', action: 'edit', allowed: false },
        { module: 'salary', action: 'view', allowed: true, scope: 'self' },
      ],
    });

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    expect(result.permissions).toEqual([
      { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
      { module: 'team', actions: ['view'], actionScopes: ['all'] },
      { module: 'salary', actions: ['view'], actionScopes: ['self'] },
    ]);
  });

  it('returns hierarchical paths — role.permissionPaths with per-member path overrides applied', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId });
    roleFindById({
      _id: roleId,
      name: 'Manager',
      isSystem: true,
      permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
      permissionPaths: [
        { path: 'team.directory.view', scope: 'all' },
        { path: 'team.profile.personal.edit', scope: 'all' },
      ],
    });
    // Force-deny team.profile.personal.edit via path override — must drop out
    // of `paths`; team.directory.view (not denied) must remain.
    // `permissionPathOverrides` is the canonical Phase 1c model — flat
    // `permissionOverrides` only drives the flat `permissions` array, not paths.
    teamMemberFindOne({
      permissionPathOverrides: [{ path: 'team.profile.personal.edit', allowed: false }],
    });

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    expect(result.paths).toEqual([{ path: 'team.directory.view', scope: 'all' }]);
  });

  it('passes actionScopes through when role permissions declare scope (Path C plumbing)', async () => {
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ userId: memberUserId, roleId });
    roleFindById({
      _id: roleId,
      name: 'Worker',
      isSystem: true,
      permissions: [
        {
          module: 'attendance',
          actions: ['view', 'mark'],
          actionScopes: ['self', 'self'],
        },
        { module: 'team', actions: ['view'] /* no actionScopes — legacy */ },
      ],
    });

    const result = await svc.getMyPermissions(workspaceId.toString(), memberUserId.toString());

    expect(result.permissions).toEqual([
      {
        module: 'attendance',
        actions: ['view', 'mark'],
        actionScopes: ['self', 'self'],
      },
      { module: 'team', actions: ['view'], actionScopes: undefined },
    ]);
  });
});
