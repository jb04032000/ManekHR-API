/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing RolesGuard — transitive schema
// imports would otherwise trip vitest's reflect-metadata pipeline. The
// stubbed `getModelToken` returns `${name}Model`, which the moduleRef mock
// below keys on.
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
import { ForbiddenException } from '@nestjs/common';
import { RolesGuard, PERMISSIONS_KEY } from '../roles.guard';
import { IS_PUBLIC_KEY } from '../../decorators/public.decorator';
import {
  REQUIRE_PERMISSION_KEY,
  AUTHENTICATED_ONLY_KEY,
} from '../../decorators/require-permission.decorator';
import { LEGACY_UNCLASSIFIED_KEY } from '../../decorators/legacy-unclassified.decorator';

describe('RolesGuard.canActivate', () => {
  let guard: RolesGuard;
  let reflector: any;
  let moduleRef: any;
  let revocationService: any;
  let workspaceModel: any;
  let memberModel: any;
  let roleModel: any;
  let teamMemberModel: any;
  let accountantInviteModel: any;
  let markers: Record<string, any>;

  const workspaceId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const roleId = new Types.ObjectId();

  beforeEach(() => {
    markers = {};
    reflector = {
      getAllAndOverride: vi.fn((key: string) => markers[key]),
      get: vi.fn((key: string) => markers[key]),
    };
    workspaceModel = { findById: vi.fn() };
    memberModel = { findOne: vi.fn() };
    roleModel = { findOne: vi.fn() };
    teamMemberModel = { findOne: vi.fn() };
    accountantInviteModel = { findOne: vi.fn() };
    moduleRef = {
      get: vi.fn((token: string) => {
        switch (token) {
          case 'WorkspaceModel':
            return workspaceModel;
          case 'WorkspaceMemberModel':
            return memberModel;
          case 'RoleModel':
            return roleModel;
          case 'TeamMemberModel':
            return teamMemberModel;
          case 'AccountantInviteModel':
            return accountantInviteModel;
          default:
            return undefined;
        }
      }),
    };
    revocationService = { isRevoked: vi.fn().mockResolvedValue(false) };
    // Guard is rebuilt per test, so its caller-context cache starts empty and
    // cannot leak resolved contexts across specs.
    const permissionEvents = { onEvent: vi.fn() };
    guard = new RolesGuard(reflector, moduleRef, revocationService, permissionEvents as any);

    // Default: no per-member overrides.
    teamMemberModel.findOne.mockReturnValue({
      select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(null) }) }),
    });
    // Default: caller is not an accepted accountant.
    accountantInviteModel.findOne.mockReturnValue({
      select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(null) }) }),
    });
  });

  function ctx(request: any) {
    return {
      getHandler: () => 'handler',
      getClass: () => 'controller',
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;
  }

  function req(overrides: any = {}) {
    return {
      user: { sub: userId.toString() },
      params: { workspaceId: workspaceId.toString() },
      body: {},
      query: {},
      headers: {},
      method: 'GET',
      url: '/x',
      ...overrides,
    };
  }

  function workspaceFindById(ws: any) {
    workspaceModel.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(ws) });
  }
  function memberFindOne(m: any) {
    memberModel.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(m) });
  }
  function roleFindOne(r: any) {
    roleModel.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(r) });
  }

  it('@Public — allows through with no authentication required', async () => {
    markers[IS_PUBLIC_KEY] = true;
    expect(await guard.canActivate(ctx(req({ user: undefined })))).toBe(true);
  });

  it('rejects an unauthenticated request that carries a marker', async () => {
    markers[PERMISSIONS_KEY] = { module: 'team', action: 'view' };
    expect(await guard.canActivate(ctx(req({ user: undefined })))).toBe(false);
  });

  it('no marker — denied fail-closed (the codemod guarantees every route is marked)', async () => {
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('@AuthenticatedOnly — allows any authenticated user, no workspace lookup', async () => {
    markers[AUTHENTICATED_ONLY_KEY] = true;
    expect(await guard.canActivate(ctx(req()))).toBe(true);
    expect(workspaceModel.findById).not.toHaveBeenCalled();
  });

  it('@LegacyUnclassified — allows any authenticated user, no workspace lookup', async () => {
    markers[LEGACY_UNCLASSIFIED_KEY] = true;
    expect(await guard.canActivate(ctx(req()))).toBe(true);
    expect(workspaceModel.findById).not.toHaveBeenCalled();
  });

  it('@RequirePermission — owner gets implicit full access', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.profile.bank.edit' };
    workspaceFindById({ _id: workspaceId, ownerId: userId });
    expect(await guard.canActivate(ctx(req()))).toBe(true);
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });

  it('@RequirePermission — allows when the role grants the path (scope satisfied)', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.directory.view', scope: 'self' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    roleFindOne({
      permissions: [],
      permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
    });
    expect(await guard.canActivate(ctx(req()))).toBe(true);
  });

  it('@RequirePermission — denies when the role lacks the path', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.profile.bank.edit' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    roleFindOne({ permissions: [], permissionPaths: [] });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('@RequirePermission — throws when no workspace can be resolved', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.directory.view' };
    await expect(guard.canActivate(ctx(req({ params: {} })))).rejects.toThrow(
      'Workspace context required',
    );
  });

  it('legacy @RequirePermissions — allows when the role grants (module, action)', async () => {
    markers[PERMISSIONS_KEY] = { module: 'team', action: 'view' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    roleFindOne({
      permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
    });
    expect(await guard.canActivate(ctx(req()))).toBe(true);
  });

  it('legacy @RequirePermissions — denies when the role lacks (module, action)', async () => {
    markers[PERMISSIONS_KEY] = { module: 'team', action: 'edit' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    roleFindOne({ permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }] });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a revoked member', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.directory.view' };
    workspaceFindById({ _id: workspaceId, ownerId });
    revocationService.isRevoked.mockResolvedValue(true);
    await expect(guard.canActivate(ctx(req()))).rejects.toThrow('revoked');
  });

  it('denies a caller with no membership in the workspace', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.directory.view' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null);
    await expect(guard.canActivate(ctx(req()))).rejects.toThrow('not a member');
  });

  it('soft-delete — denies the OWNER on a soft-deleted workspace (not resolvable into an owner session)', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.directory.view' };
    // Owner of a workspace that has since been soft-deleted. Without the
    // isDeleted guard the owner check would short-circuit to full access.
    workspaceFindById({ _id: workspaceId, ownerId: userId, isDeleted: true });
    await expect(guard.canActivate(ctx(req()))).rejects.toThrow('Workspace not found');
    // Owner short-circuit must NOT have fired — the deleted workspace is
    // treated as absent before the ownership check.
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });

  it('soft-delete — denies a MEMBER on a soft-deleted workspace before any membership lookup', async () => {
    markers[PERMISSIONS_KEY] = { module: 'team', action: 'view' };
    workspaceFindById({ _id: workspaceId, ownerId, isDeleted: true });
    await expect(guard.canActivate(ctx(req()))).rejects.toThrow('Workspace not found');
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });

  it('a real permission marker is enforced even if @LegacyUnclassified coexists', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.profile.bank.edit' };
    markers[LEGACY_UNCLASSIFIED_KEY] = true;
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    roleFindOne({ permissions: [], permissionPaths: [] });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits a path route when a permissionPathOverrides allow-entry grants it', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.profile.bank.edit', scope: 'all' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    // Role grants nothing relevant for this path.
    roleFindOne({ permissions: [], permissionPaths: [] });
    // TeamMember row has a path override that allows the requested path.
    teamMemberModel.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: vi.fn().mockResolvedValue({
            permissionOverrides: [],
            permissionPathOverrides: [
              { path: 'team.profile.bank.edit', allowed: true, scope: 'all' },
            ],
          }),
        }),
      }),
    });
    expect(await guard.canActivate(ctx(req()))).toBe(true);
  });

  it('denies a path route when a permissionPathOverrides deny-entry removes a role grant', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'team.directory.view', scope: 'self' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne({ roleId });
    // Role grants the path at scope 'all'.
    roleFindOne({
      permissions: [],
      permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
    });
    // TeamMember row has a path override that denies (force-removes) the path.
    teamMemberModel.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: vi.fn().mockResolvedValue({
            permissionOverrides: [],
            permissionPathOverrides: [{ path: 'team.directory.view', allowed: false }],
          }),
        }),
      }),
    });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── External accountant (SEC-3) — grants derived from the accepted invite ──
  function accountantInviteFindOne(invite: any) {
    accountantInviteModel.findOne.mockReturnValue({
      select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(invite) }) }),
    });
  }

  it('accountant — passes a granted read path derived from the accepted invite', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'finance.invoice.view', scope: 'self' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null); // not a workspace member
    accountantInviteFindOne({
      scopeRole: 'read_only',
      modulePermissions: [{ module: 'finance', access: 'read' }],
    });
    expect(await guard.canActivate(ctx(req()))).toBe(true);
  });

  it('accountant — read_only is denied a finance write path', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'finance.invoice.post' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null);
    accountantInviteFindOne({
      scopeRole: 'read_only',
      modulePermissions: [{ module: 'finance', access: 'write' }],
    });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accountant — adjusting_entry + finance:write allows a bookkeeping write (post)', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'finance.invoice.post' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null);
    accountantInviteFindOne({
      scopeRole: 'adjusting_entry',
      modulePermissions: [{ module: 'finance', access: 'write' }],
    });
    expect(await guard.canActivate(ctx(req()))).toBe(true);
  });

  it('accountant — never gets destructive finance paths (delete) even with write+adjusting', async () => {
    markers[REQUIRE_PERMISSION_KEY] = { path: 'finance.invoice.delete' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null);
    accountantInviteFindOne({
      scopeRole: 'adjusting_entry',
      modulePermissions: [{ module: 'finance', access: 'write' }],
    });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accountant — legacy @RequirePermissions routes fail closed', async () => {
    markers[PERMISSIONS_KEY] = { module: 'finance', action: 'view' };
    workspaceFindById({ _id: workspaceId, ownerId });
    memberFindOne(null);
    accountantInviteFindOne({
      scopeRole: 'read_only',
      modulePermissions: [{ module: 'finance', access: 'read' }],
    });
    await expect(guard.canActivate(ctx(req()))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
