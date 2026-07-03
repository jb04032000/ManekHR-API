/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing the migration — the transitive
// Role schema import would otherwise trip vitest's reflect-metadata pipeline.
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

import { BackfillLeaveSelfServiceGrantDepsService } from '../backfill-leave-self-service-grant-deps';

describe('BackfillLeaveSelfServiceGrantDepsService', () => {
  let roleModel: any;
  let svc: BackfillLeaveSelfServiceGrantDepsService;

  beforeEach(() => {
    roleModel = { find: vi.fn(), updateOne: vi.fn().mockResolvedValue({}) };
    svc = new BackfillLeaveSelfServiceGrantDepsService(roleModel);
  });

  function findReturns(roles: any[]) {
    roleModel.find.mockReturnValue({ exec: vi.fn().mockResolvedValue(roles) });
  }

  it('adds leave.balance.view to a role holding only leave.request.view', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Leave Viewer',
        isSystem: false,
        permissions: [],
        permissionPaths: [{ path: 'leave.request.view', scope: 'self' }],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    const paths: string[] = update.$set.permissionPaths.map((g: any) => g.path);
    expect(paths).toContain('leave.request.view');
    expect(paths).toContain('leave.balance.view');
  });

  it('adds BOTH read leaves for a role holding leave.compOff.apply, preserving non-leave paths', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Comp-off Claimer',
        isSystem: false,
        permissions: [],
        permissionPaths: [
          { path: 'leave.compOff.apply', scope: 'self' },
          { path: 'team.directory.view', scope: 'self' },
        ],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    const paths: string[] = update.$set.permissionPaths.map((g: any) => g.path);
    expect(paths).toContain('leave.request.view');
    expect(paths).toContain('leave.balance.view');
    // Non-leave grant left exactly as it was.
    expect(paths).toContain('team.directory.view');
  });

  it('is idempotent — a role already holding the full read bundle is untouched', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Worker',
        isSystem: true,
        permissions: [],
        permissionPaths: [
          { path: 'leave.request.apply', scope: 'self' },
          { path: 'leave.request.view', scope: 'self' },
          { path: 'leave.request.cancel', scope: 'self' },
          { path: 'leave.balance.view', scope: 'self' },
          { path: 'leave.compOff.apply', scope: 'self' },
        ],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('skips a role with EMPTY permissionPaths (owned by the populate-once backfill)', async () => {
    findReturns([
      { _id: 'r1', name: 'Member', isSystem: true, permissions: [], permissionPaths: [] },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('is bounded to leave.* — never writes team/attendance deps (e.g. member.create profile bundle)', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Onboarder',
        isSystem: false,
        permissions: [],
        // member.create declares requires on every team.profile.*.edit path —
        // resolveImplicitDeps would add them, but this migration must ignore
        // every non-leave addition and write nothing.
        permissionPaths: [
          { path: 'team.member.create', scope: 'all' },
          { path: 'team.directory.view', scope: 'all' },
        ],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('records an error and continues when an update throws', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Leave Viewer A',
        isSystem: false,
        permissions: [],
        permissionPaths: [{ path: 'leave.request.view', scope: 'self' }],
      },
      {
        _id: 'r2',
        name: 'Leave Viewer B',
        isSystem: false,
        permissions: [],
        permissionPaths: [{ path: 'leave.request.view', scope: 'self' }],
      },
    ]);
    roleModel.updateOne
      .mockResolvedValueOnce({ acknowledged: true })
      .mockRejectedValueOnce(new Error('mongo down'));

    const result = await svc.run();

    expect(result.rolesScanned).toBe(2);
    expect(result.rolesUpdated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Leave Viewer B');
  });
});
