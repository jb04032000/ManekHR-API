/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of } from 'rxjs';

// Stub @nestjs/mongoose decorators before any schema imports fire.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: noop,
    Schema: noop,
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { PermissionVersionInterceptor } from '../permission-version.interceptor';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemberModel(result: any) {
  return {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(result),
    }),
  };
}

function makeRoleModel(result: any) {
  return {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(result),
    }),
  };
}

function makeTeamMemberModel(result: any) {
  return {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(result),
    }),
  };
}

function makeCtx(params: Record<string, string>, user: Record<string, string> | undefined) {
  const setHeader = vi.fn();
  const req = { params, user };
  const res = { setHeader };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    setHeader,
    res,
  };
}

function makeNext() {
  return { handle: () => of('ok') };
}

async function runInterceptor(interceptor: PermissionVersionInterceptor, ctx: any) {
  const result = interceptor.intercept(ctx, makeNext());
  // Collect the observable — this triggers the tap side-effect
  await new Promise<void>((resolve) => {
    result.subscribe({ complete: resolve, error: resolve });
  });
  // Give the async tap callback a chance to complete
  await Promise.resolve();
  await Promise.resolve();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PermissionVersionInterceptor', () => {
  let memberModel: ReturnType<typeof makeMemberModel>;
  let roleModel: ReturnType<typeof makeRoleModel>;
  let teamMemberModel: ReturnType<typeof makeTeamMemberModel>;
  let interceptor: PermissionVersionInterceptor;

  const workspaceId = '507f1f77bcf86cd799439011';
  const userId = '507f1f77bcf86cd799439022';
  const roleId = { toString: () => '507f1f77bcf86cd799439033' };

  beforeEach(() => {
    memberModel = makeMemberModel({ roleId, status: 'active' });
    roleModel = makeRoleModel({ permissions: [], permissionPaths: [] });
    teamMemberModel = makeTeamMemberModel(null);
    interceptor = new PermissionVersionInterceptor(
      memberModel as any,
      teamMemberModel as any,
      roleModel as any,
    );
  });

  it('emits X-Permission-Version header for workspace-scoped authenticated requests', async () => {
    const { setHeader, ...ctx } = makeCtx({ workspaceId }, { sub: userId });

    await runInterceptor(interceptor, ctx);

    expect(setHeader).toHaveBeenCalledWith(
      'X-Permission-Version',
      expect.stringMatching(/^[0-9a-f]{16}$/),
    );
  });

  it('does not emit header when workspaceId param is missing', async () => {
    const { setHeader, ...ctx } = makeCtx({}, { sub: userId });

    await runInterceptor(interceptor, ctx);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not emit header when user is unauthenticated (no user object)', async () => {
    const { setHeader, ...ctx } = makeCtx({ workspaceId }, undefined);

    await runInterceptor(interceptor, ctx);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not emit header when user.sub is missing', async () => {
    const { setHeader, ...ctx } = makeCtx({ workspaceId }, {});

    await runInterceptor(interceptor, ctx);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not emit header when member lookup returns no active member', async () => {
    memberModel = makeMemberModel(null);
    interceptor = new PermissionVersionInterceptor(
      memberModel as any,
      teamMemberModel as any,
      roleModel as any,
    );
    const { setHeader, ...ctx } = makeCtx({ workspaceId }, { sub: userId });

    await runInterceptor(interceptor, ctx);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not crash and skips header when DB lookup throws', async () => {
    const brokenModel = {
      findOne: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      }),
    };
    interceptor = new PermissionVersionInterceptor(
      brokenModel as any,
      teamMemberModel as any,
      roleModel as any,
    );
    const { setHeader, ...ctx } = makeCtx({ workspaceId }, { sub: userId });

    // Must not throw
    await expect(runInterceptor(interceptor, ctx)).resolves.toBeUndefined();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('emits a stable hash for the same member across multiple calls', async () => {
    const { setHeader, ...ctx } = makeCtx({ workspaceId }, { sub: userId });

    await runInterceptor(interceptor, ctx);
    const firstCall = (setHeader as any).mock.calls[0][1];

    await runInterceptor(interceptor, ctx);
    const secondCall = (setHeader as any).mock.calls[1][1];

    expect(firstCall).toBe(secondCall);
  });
});
