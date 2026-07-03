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

import { BackfillRoleAttendancePermissionPathsService } from '../backfill-role-attendance-permission-paths';
import { DEFAULT_MANAGER_ROLE } from '../../modules/rbac/role-seeder.constants';

const NEW_MODULES = ['attendance', 'leave', 'regularization'];
const isNew = (p: string) => NEW_MODULES.includes(p.split('.')[0]);

describe('BackfillRoleAttendancePermissionPathsService', () => {
  let roleModel: any;
  let svc: BackfillRoleAttendancePermissionPathsService;

  beforeEach(() => {
    roleModel = { find: vi.fn(), updateOne: vi.fn().mockResolvedValue({}) };
    svc = new BackfillRoleAttendancePermissionPathsService(roleModel);
  });

  function findReturns(roles: any[]) {
    roleModel.find.mockReturnValue({ exec: vi.fn().mockResolvedValue(roles) });
  }

  it('unions the new-module preset paths onto a system role WITHOUT clobbering its team paths', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Manager',
        isSystem: true,
        permissions: [],
        permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    const paths: string[] = update.$set.permissionPaths.map((g: any) => g.path);
    // Original team path preserved.
    expect(paths).toContain('team.directory.view');
    // Every new-module path from the Manager preset is now present.
    for (const g of DEFAULT_MANAGER_ROLE.permissionPaths.filter((x) => isNew(x.path))) {
      expect(paths).toContain(g.path);
    }
    // No team path other than the original was injected.
    expect(paths.filter((p) => p.startsWith('team.'))).toEqual(['team.directory.view']);
  });

  it('skips a role with EMPTY permissionPaths (owned by the populate-once backfill)', async () => {
    findReturns([
      { _id: 'r1', name: 'Manager', isSystem: true, permissions: [], permissionPaths: [] },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('is idempotent — a role already holding every new path is left untouched', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Manager',
        isSystem: true,
        permissions: [],
        permissionPaths: [...DEFAULT_MANAGER_ROLE.permissionPaths],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('widens an existing self grant to all when the preset grants it wider', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Manager',
        isSystem: true,
        permissions: [],
        permissionPaths: [
          { path: 'team.directory.view', scope: 'all' },
          { path: 'attendance.record.view', scope: 'self' },
        ],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    const recordView = update.$set.permissionPaths.find(
      (g: any) => g.path === 'attendance.record.view',
    );
    expect(recordView.scope).toBe('all');
  });

  it('converts a custom role from its legacy flat attendance grant (least-privilege)', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Floor Lead',
        isSystem: false,
        permissions: [{ module: 'attendance', actions: ['mark'], actionScopes: ['self'] }],
        permissionPaths: [{ path: 'team.directory.view', scope: 'self' }],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    const paths: string[] = update.$set.permissionPaths.map((g: any) => g.path);
    expect(paths).toContain('attendance.record.mark');
    expect(paths).toContain('attendance.selfPunch.create');
    // Existing team path preserved; no approval/analytics over-grant.
    expect(paths).toContain('team.directory.view');
    expect(paths.some((p) => p.endsWith('approval.decide'))).toBe(false);
  });

  it('skips a non-empty role with no new-module grants to add', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Team Only',
        isSystem: false,
        permissions: [{ module: 'team', actions: ['view'], actionScopes: ['all'] }],
        permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
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
        name: 'Manager',
        isSystem: true,
        permissions: [],
        permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
      },
      {
        _id: 'r2',
        name: 'Partner',
        isSystem: true,
        permissions: [],
        permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
      },
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
