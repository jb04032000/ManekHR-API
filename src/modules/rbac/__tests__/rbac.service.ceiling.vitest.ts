/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing RbacService so that the
// transitive schema imports (Role, Workspace, WorkspaceMember, TeamMember)
// don't trip the "Cannot determine type" reflection error under vitest's
// esbuild transform. We never use Mongoose here — all Models are plain mocks.
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
import { RbacService } from '../rbac.service';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';

/**
 * Permission-ceiling + system-role coverage for the R-6 security fix.
 *
 * Verifies:
 *   - create: a non-owner actor CANNOT mint a role granting a (module,
 *     action, scope) tuple the actor does not themselves hold.
 *   - create: the workspace owner bypasses the ceiling entirely.
 *   - create: a non-owner actor CAN author a role within their own ceiling.
 *   - update: a non-owner CANNOT edit a role with `isSystem: true`.
 *   - update: the owner CAN edit a system role.
 *   - create (path ceiling): non-owner CANNOT grant a path they do not hold.
 *   - create (path ceiling): workspace owner CAN grant any path (null bypass).
 */
describe('RbacService — permission ceiling + system-role guard (R-6)', () => {
  const workspaceId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const nonOwnerId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const actorRoleId = new Types.ObjectId();

  let roleModel: any;
  let workspaceModel: any;
  let memberModel: any;
  let teamMemberModel: any;
  let svc: RbacService;

  // The actor's assigned role: holds team:view@all only — a deliberately
  // narrow ceiling.
  const actorRoleDoc = {
    _id: actorRoleId,
    isSystem: false,
    permissions: [{ module: AppModule.TEAM, actions: [ModuleAction.VIEW], actionScopes: ['all'] }],
  };

  // Chainable Mongoose query stub. `.exec()` / `.lean()` resolve `value`.
  const query = (value: unknown) => {
    const q: any = {
      exec: vi.fn().mockResolvedValue(value),
      select: vi.fn(),
      lean: vi.fn(),
    };
    q.select.mockReturnValue(q);
    q.lean.mockReturnValue(q);
    return q;
  };

  beforeEach(() => {
    workspaceModel = {
      // Workspace owned by ownerId. isWorkspaceOwner compares ownerId.toString().
      findById: vi.fn().mockReturnValue(query({ _id: workspaceId, ownerId })),
    };
    memberModel = {
      // Non-owner actor's active membership → actorRoleId.
      findOne: vi
        .fn()
        .mockReturnValue(query({ userId: nonOwnerId, status: 'active', roleId: actorRoleId })),
    };
    teamMemberModel = {
      // No per-member overrides for the actor.
      findOne: vi.fn().mockReturnValue(query(null)),
    };
    // roleModel must be `new`-able — `create()` does `new this.roleModel({...})`.
    // The constructed instance carries a resolving `.save()`. Static query
    // methods (`findById`, `findOne`) are attached as properties.
    roleModel = vi.fn().mockImplementation((doc: unknown) => ({
      ...(doc as object),
      save: vi.fn().mockResolvedValue({ _id: roleId, ...(doc as object) }),
    }));
    // findById → actor's own role (ceiling source).
    roleModel.findById = vi.fn().mockReturnValue(query(actorRoleDoc));
    // findOne → the target role being updated; overridden per-test.
    roleModel.findOne = vi.fn().mockReturnValue(query(null));

    const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) } as any;
    svc = new RbacService(roleModel, workspaceModel, memberModel, teamMemberModel, auditService);
  });

  it('create: non-owner CANNOT grant a permission they do not hold', async () => {
    // Actor holds only team:view@all; tries to grant salary:view@all.
    await expect(
      svc.create(workspaceId.toString(), nonOwnerId.toString(), {
        name: 'Escalated Role',
        permissions: [
          { module: AppModule.SALARY, actions: [ModuleAction.VIEW], actionScopes: ['all'] },
        ],
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: non-owner CANNOT widen scope beyond what they hold (self → all)', async () => {
    // Actor holds team:view@all; granting team:view@all is fine, but team:edit
    // is an action the actor lacks entirely.
    await expect(
      svc.create(workspaceId.toString(), nonOwnerId.toString(), {
        name: 'Edit Role',
        permissions: [
          { module: AppModule.TEAM, actions: [ModuleAction.EDIT], actionScopes: ['all'] },
        ],
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: non-owner CAN author a role within their own ceiling', async () => {
    // Actor holds team:view@all → granting team:view@all (or @self) is allowed.
    const created = await svc.create(workspaceId.toString(), nonOwnerId.toString(), {
      name: 'View Team Role',
      permissions: [
        { module: AppModule.TEAM, actions: [ModuleAction.VIEW], actionScopes: ['all'] },
      ],
    } as any);
    expect(created).toBeDefined();
  });

  it('create: workspace owner bypasses the ceiling entirely', async () => {
    // Owner grants salary:view@all — an action no role-derived ceiling covers.
    const created = await svc.create(workspaceId.toString(), ownerId.toString(), {
      name: 'Owner-authored Role',
      permissions: [
        { module: AppModule.SALARY, actions: [ModuleAction.VIEW], actionScopes: ['all'] },
      ],
    } as any);
    expect(created).toBeDefined();
    // Owner short-circuits — never resolves a membership for the ceiling.
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });

  it('update: non-owner CANNOT edit a system role', async () => {
    // Target role is a seeded system role.
    roleModel.findOne.mockReturnValue(
      query({ _id: roleId, workspaceId, isSystem: true, permissions: [] }),
    );
    await expect(
      svc.update(workspaceId.toString(), roleId.toString(), nonOwnerId.toString(), {
        name: 'Renamed System Role',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('update: owner CAN edit a system role', async () => {
    const save = vi.fn().mockResolvedValue({ _id: roleId, name: 'Renamed' });
    roleModel.findOne.mockReturnValue(
      query({ _id: roleId, workspaceId, isSystem: true, permissions: [], save }),
    );
    const updated = await svc.update(
      workspaceId.toString(),
      roleId.toString(),
      ownerId.toString(),
      {
        name: 'Renamed',
      },
    );
    expect(updated).toBeDefined();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('create (path ceiling): non-owner CANNOT grant a path they do not hold', async () => {
    // Actor's role has no permissionPaths — effective path ceiling is [].
    // Attempting to grant team.profile.bank.edit@all must throw ForbiddenException.
    roleModel.findById.mockReturnValue(
      query({
        ...actorRoleDoc,
        permissionPaths: [], // actor holds no path grants
      }),
    );
    await expect(
      svc.create(workspaceId.toString(), nonOwnerId.toString(), {
        name: 'Bank Edit Role',
        permissions: [],
        permissionPaths: [{ path: 'team.profile.bank.edit', scope: 'all' }],
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create (path ceiling): workspace owner CAN grant any path — null ceiling bypass', async () => {
    // Owner has null ceiling — granting team.profile.bank.edit@all must succeed.
    // Coherence (Phase 1d) demands a matching view grant; include it so the
    // owner-bypass-ceiling assertion (the actual subject of this test) isn't
    // shadowed by the unrelated edit-implies-view rule.
    const created = await svc.create(workspaceId.toString(), ownerId.toString(), {
      name: 'Owner Bank Edit Role',
      permissions: [],
      permissionPaths: [
        { path: 'team.profile.bank.view', scope: 'all' },
        { path: 'team.profile.bank.edit', scope: 'all' },
      ],
    } as any);
    expect(created).toBeDefined();
    // Owner short-circuits — no membership lookup for ceiling.
    expect(memberModel.findOne).not.toHaveBeenCalled();
  });
});
