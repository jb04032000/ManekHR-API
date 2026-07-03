/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Backfill: seed salary.declare_tax onto existing seeded roles — Worker @self
 * (self-declare own taxes) + HR @all (keep HR's all-scoped upsert path). Worker
 * gets a fresh salary grant; HR's existing salary grant is appended to. Already-
 * granted roles are skipped (idempotent).
 * Links: backfill-salary-declare-tax-grant.ts, role-seeder.constants.ts,
 * salary.controller.ts upsertTaxDeclaration (DECLARE_TAX gate).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { Types } from 'mongoose';
import { BackfillSalaryDeclareTaxGrantService } from '../backfill-salary-declare-tax-grant';

// The service queries `{ isSystem: true, name }` once per target role (Worker,
// then HR). This mock returns the matching role for each name so a single run
// exercises both branches.
function buildRoleModel(rolesByName: Record<string, any[]>) {
  return {
    find: vi.fn().mockImplementation((q: any) => ({
      exec: vi.fn().mockResolvedValue(rolesByName[q.name] ?? []),
    })),
    updateOne: vi.fn().mockResolvedValue({}),
  };
}

describe('BackfillSalaryDeclareTaxGrantService', () => {
  it('adds a fresh salary [declare_tax] self grant to a Worker with no salary grant', async () => {
    const worker = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [
        { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
        { module: 'leave', actions: ['view', 'apply_leave'], actionScopes: ['self', 'self'] },
      ],
    };
    const roleModel = buildRoleModel({ Worker: [worker], HR: [] });
    const svc = new BackfillSalaryDeclareTaxGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const setArg = roleModel.updateOne.mock.calls[0][1].$set.permissions;
    const salaryGrant = setArg.find((p: any) => p.module === 'salary');
    expect(salaryGrant).toBeDefined();
    expect(salaryGrant.actions).toContain('declare_tax');
    expect(salaryGrant.actionScopes[salaryGrant.actions.indexOf('declare_tax')]).toBe('self');
    // existing grants preserved
    expect(setArg.some((p: any) => p.module === 'attendance')).toBe(true);
  });

  it('appends declare_tax @all to an HR role that already has a salary grant', async () => {
    const hr = {
      _id: new Types.ObjectId(),
      name: 'HR',
      permissions: [{ module: 'salary', actions: ['view', 'edit'], actionScopes: ['all', 'all'] }],
    };
    const roleModel = buildRoleModel({ Worker: [], HR: [hr] });
    const svc = new BackfillSalaryDeclareTaxGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const setArg = roleModel.updateOne.mock.calls[0][1].$set.permissions;
    const salaryGrant = setArg.find((p: any) => p.module === 'salary');
    expect(salaryGrant.actions).toEqual(['view', 'edit', 'declare_tax']);
    expect(salaryGrant.actionScopes).toEqual(['all', 'all', 'all']);
  });

  it('is idempotent: a role already holding declare_tax is skipped', async () => {
    const worker = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [
        {
          module: 'salary',
          actions: ['request_advance', 'declare_tax'],
          actionScopes: ['self', 'self'],
        },
      ],
    };
    const roleModel = buildRoleModel({ Worker: [worker], HR: [] });
    const svc = new BackfillSalaryDeclareTaxGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });
});
