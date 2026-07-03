/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing ResourceScopeGuard — transitive schema
// imports would otherwise trip vitest's reflect-metadata pipeline.
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
import { ResourceScopeGuard } from '../resource-scope.guard';

/**
 * Soft-delete scope-resolution guard for ResourceScopeGuard.
 *
 * A soft-deleted workspace must be treated like an absent one (defer to
 * RolesGuard, which 403s it) — the owner of a deleted workspace must NOT be
 * decorated with an active `isOwner` resource scope from a stale id.
 */
describe('ResourceScopeGuard — soft-delete guard', () => {
  let workspaceModel: any;
  let scopesService: any;
  let moduleRef: any;
  let reflector: any;
  let guard: ResourceScopeGuard;

  const workspaceId = new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();

  beforeEach(() => {
    workspaceModel = {
      findById: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ _id: workspaceId, ownerId: ownerUserId, isDeleted: true }),
      }),
    };
    scopesService = { loadForUser: vi.fn() };
    moduleRef = {
      get: vi.fn((token: any) => {
        if (token === 'WorkspaceModel') return workspaceModel;
        return scopesService;
      }),
    };
    reflector = { getAllAndOverride: vi.fn(), get: vi.fn() };
    guard = new ResourceScopeGuard(moduleRef, reflector);
  });

  function ctx(request: any) {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;
  }

  it('defers (no owner scope decorated) for a soft-deleted workspace', async () => {
    const request: any = {
      user: { sub: ownerUserId.toString() },
      params: { workspaceId: workspaceId.toString() },
      body: {},
      query: {},
      headers: {},
    };

    const result = await guard.canActivate(ctx(request));

    expect(result).toBe(true);
    // The owner-bypass branch must NOT have decorated an active scope — a
    // deleted workspace is handled like an absent one (RolesGuard 403s it).
    expect(request.resourceScope).toBeUndefined();
    // Must not have attempted to load a scope row for the deleted workspace.
    expect(scopesService.loadForUser).not.toHaveBeenCalled();
  });
});
