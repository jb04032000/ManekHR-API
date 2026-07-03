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

import { BackfillRolePermissionPathsService } from '../backfill-role-permission-paths';
import { DEFAULT_MANAGER_ROLE } from '../../modules/rbac/role-seeder.constants';

describe('BackfillRolePermissionPathsService', () => {
  let roleModel: any;
  let svc: BackfillRolePermissionPathsService;

  beforeEach(() => {
    roleModel = { find: vi.fn(), updateOne: vi.fn().mockResolvedValue({}) };
    svc = new BackfillRolePermissionPathsService(roleModel);
  });

  function findReturns(roles: any[]) {
    roleModel.find.mockReturnValue({ exec: vi.fn().mockResolvedValue(roles) });
  }

  it('backfills a system role by name with the exact preset paths', async () => {
    findReturns([
      { _id: 'r1', name: 'Manager', isSystem: true, permissions: [], permissionPaths: [] },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [filter, update] = roleModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'r1' });
    expect(update.$set.permissionPaths).toEqual(DEFAULT_MANAGER_ROLE.permissionPaths);
  });

  it('skips a role that already has permissionPaths — never clobbers owner edits', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'HR',
        isSystem: true,
        permissions: [],
        permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('converts a custom role from its legacy flat permissions', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Floor Lead',
        isSystem: false,
        permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
        permissionPaths: [],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    expect(update.$set.permissionPaths.map((g: any) => g.path)).toContain('team.directory.view');
  });

  it('falls back to legacy conversion for a renamed (name-unmatched) system role', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Supervisor (renamed)',
        isSystem: true,
        permissions: [{ module: 'team', actions: ['create'], actionScopes: ['all'] }],
        permissionPaths: [],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    expect(update.$set.permissionPaths).toEqual([{ path: 'team.member.create', scope: 'all' }]);
  });

  it('skips a role with no convertible grants without writing', async () => {
    findReturns([
      { _id: 'r1', name: 'Empty', isSystem: false, permissions: [], permissionPaths: [] },
    ]);

    const result = await svc.run();

    expect(result.rolesScanned).toBe(1);
    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('records an error and continues when an update throws', async () => {
    findReturns([
      { _id: 'r1', name: 'Manager', isSystem: true, permissions: [], permissionPaths: [] },
      { _id: 'r2', name: 'Partner', isSystem: true, permissions: [], permissionPaths: [] },
    ]);
    roleModel.updateOne
      .mockResolvedValueOnce({ acknowledged: true })
      .mockRejectedValueOnce(new Error('mongo down'));

    const result = await svc.run();

    expect(result.rolesScanned).toBe(2);
    expect(result.rolesUpdated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Partner');
  });
});
