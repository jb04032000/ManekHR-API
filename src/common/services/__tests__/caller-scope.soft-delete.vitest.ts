/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing CallerScopeService — the transitive
// schema imports would otherwise trip vitest's reflect-metadata pipeline. The
// stubbed `getModelToken` returns `${name}Model`, which the moduleRef mock
// below keys on. Mirrors the roles.guard vitest pattern.
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
import { CallerScopeService } from '../caller-scope.service';

/**
 * Soft-delete scope-resolution guard.
 *
 * A user-side workspace delete sets `isDeleted: true` but retains the row and
 * `ownerId`. The scope resolver must NOT resurrect a soft-deleted workspace
 * into an active owner scope from a stale workspace id — otherwise the owner
 * would still resolve to implicit `all` scope on a hidden workspace.
 */
describe('CallerScopeService.resolve — soft-delete guard', () => {
  let workspaceModel: any;
  let memberModel: any;
  let roleModel: any;
  let teamMemberModel: any;
  let moduleRef: any;
  let svc: CallerScopeService;

  const workspaceId = new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();

  beforeEach(() => {
    // OLD (unguarded) code path: findById returns the deleted workspace, whose
    // ownerId matches the caller → owner short-circuit. NEW (guarded) path:
    // findOne filters on `isDeleted: { $ne: true }` → null → no owner.
    workspaceModel = {
      findById: vi.fn().mockReturnValue({
        lean: () => ({
          exec: () => Promise.resolve({ _id: workspaceId, ownerId: ownerUserId, isDeleted: true }),
        }),
      }),
      findOne: vi.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(null) }),
      }),
    };
    teamMemberModel = {
      findOne: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
      }),
    };
    memberModel = {
      findOne: vi.fn().mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(null) }),
      }),
    };
    roleModel = {
      findById: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
    };

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
          default:
            return undefined;
        }
      }),
    };

    svc = new CallerScopeService(moduleRef);
  });

  it('does NOT resolve the owner of a soft-deleted workspace into an owner scope', async () => {
    const ctx = await svc.resolve(workspaceId.toHexString(), ownerUserId.toHexString());

    // Fail-closed: a deleted workspace yields no owner short-circuit and no
    // grants, so every effective scope is null.
    expect(ctx.isOwner).toBe(false);
    expect(ctx.permissions).toEqual([]);
    expect(ctx.permissionPaths).toEqual([]);
    expect(svc.effectiveScope(ctx, 'attendance', 'view')).toBeNull();
  });

  it('queries the workspace with an isDeleted exclusion filter', async () => {
    await svc.resolve(workspaceId.toHexString(), ownerUserId.toHexString());

    expect(workspaceModel.findOne).toHaveBeenCalled();
    const filter = workspaceModel.findOne.mock.calls[0][0];
    expect(String(filter._id)).toBe(workspaceId.toHexString());
    expect(filter.isDeleted?.$ne).toBe(true);
  });
});
