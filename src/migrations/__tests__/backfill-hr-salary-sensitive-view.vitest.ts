/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Neutralise @nestjs/mongoose decorators before the migration (and the Role
// schema graph it imports) is evaluated.
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

import { BackfillHrSalarySensitiveViewService } from '../backfill-hr-salary-sensitive-view';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';

function hrRole(salaryActions: ModuleAction[]) {
  return {
    _id: 'r1',
    name: 'HR',
    isSystem: true,
    permissions: [{ module: AppModule.SALARY, actions: salaryActions, actionScopes: ['all'] }],
  };
}

describe('BackfillHrSalarySensitiveViewService', () => {
  let roleModel: any;

  beforeEach(() => vi.clearAllMocks());

  it('appends sensitive_view to a system HR role missing it', async () => {
    const role = hrRole([ModuleAction.VIEW, ModuleAction.EDIT]);
    const updateOne = vi.fn().mockResolvedValue({});
    roleModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([role]) }),
      updateOne,
    };
    const svc = new BackfillHrSalarySensitiveViewService(roleModel);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const setPerms = updateOne.mock.calls[0][1].$set.permissions;
    const salary = setPerms.find((p: any) => p.module === AppModule.SALARY);
    expect(salary.actions).toContain(ModuleAction.SENSITIVE_VIEW);
  });

  it('is idempotent when sensitive_view already present', async () => {
    const role = hrRole([ModuleAction.VIEW, ModuleAction.EDIT, ModuleAction.SENSITIVE_VIEW]);
    const updateOne = vi.fn();
    roleModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([role]) }),
      updateOne,
    };
    const svc = new BackfillHrSalarySensitiveViewService(roleModel);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('skips a role with no salary grant without writing', async () => {
    const role = {
      _id: 'r2',
      name: 'HR',
      isSystem: true,
      permissions: [
        { module: AppModule.ATTENDANCE, actions: [ModuleAction.VIEW], actionScopes: ['all'] },
      ],
    };
    const updateOne = vi.fn();
    roleModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([role]) }),
      updateOne,
    };
    const svc = new BackfillHrSalarySensitiveViewService(roleModel);

    const result = await svc.run();

    expect(result.rolesScanned).toBe(1);
    expect(result.rolesUpdated).toBe(0);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('preserves other permissions and actionScopes when appending', async () => {
    const role = {
      _id: 'r3',
      name: 'HR',
      isSystem: true,
      permissions: [
        { module: AppModule.ATTENDANCE, actions: [ModuleAction.VIEW], actionScopes: ['all'] },
        {
          module: AppModule.SALARY,
          actions: [ModuleAction.VIEW, ModuleAction.EDIT],
          actionScopes: ['all', 'all'],
        },
      ],
    };
    const updateOne = vi.fn().mockResolvedValue({});
    roleModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([role]) }),
      updateOne,
    };
    const svc = new BackfillHrSalarySensitiveViewService(roleModel);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const setPerms = updateOne.mock.calls[0][1].$set.permissions;
    // attendance grant preserved
    expect(setPerms.find((p: any) => p.module === AppModule.ATTENDANCE)).toBeDefined();
    // salary now has 3 actions
    const salary = setPerms.find((p: any) => p.module === AppModule.SALARY);
    expect(salary.actions).toHaveLength(3);
    expect(salary.actions).toContain(ModuleAction.SENSITIVE_VIEW);
    // actionScopes parallel array stays in sync
    expect(salary.actionScopes).toHaveLength(3);
  });

  it('records an error and continues when an update throws', async () => {
    const role1 = hrRole([ModuleAction.VIEW, ModuleAction.EDIT]);
    const role2 = { ...hrRole([ModuleAction.VIEW, ModuleAction.EDIT]), _id: 'r2' };
    const updateOne = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('mongo down'));
    roleModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([role1, role2]) }),
      updateOne,
    };
    const svc = new BackfillHrSalarySensitiveViewService(roleModel);

    const result = await svc.run();

    expect(result.rolesScanned).toBe(2);
    expect(result.rolesUpdated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('mongo down');
  });
});
