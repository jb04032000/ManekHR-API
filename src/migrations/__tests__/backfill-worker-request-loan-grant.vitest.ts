/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Backfill: seed salary.request_loan (self) onto existing seeded Worker roles.
 * The seeded Worker now carries a salary grant, so the backfill APPENDS
 * request_loan to it; a Worker with no salary grant gets a fresh one; an
 * already-granted role is skipped (idempotent).
 * Links: backfill-worker-request-loan-grant.ts, role-seeder.constants.ts.
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
import { BackfillWorkerRequestLoanGrantService } from '../backfill-worker-request-loan-grant';

function buildRoleModel(roleDocs: any[]) {
  return {
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(roleDocs) }),
    updateOne: vi.fn().mockResolvedValue({}),
  };
}

describe('BackfillWorkerRequestLoanGrantService', () => {
  it('appends request_loan @self to an existing Worker salary grant, keeping arrays in lockstep', async () => {
    const role = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [
        { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
        {
          module: 'salary',
          actions: ['request_advance', 'declare_tax'],
          actionScopes: ['self', 'self'],
        },
      ],
    };
    const roleModel = buildRoleModel([role]);
    const svc = new BackfillWorkerRequestLoanGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    expect(roleModel.updateOne).toHaveBeenCalledTimes(1);
    const setArg = roleModel.updateOne.mock.calls[0][1].$set.permissions;
    const salaryGrant = setArg.find((p: any) => p.module === 'salary');
    expect(salaryGrant).toBeDefined();
    expect(salaryGrant.actions).toContain('request_loan');
    expect(salaryGrant.actionScopes[salaryGrant.actions.indexOf('request_loan')]).toBe('self');
    // existing salary actions + scopes preserved in lockstep
    expect(salaryGrant.actions).toContain('request_advance');
    expect(salaryGrant.actions).toContain('declare_tax');
    expect(salaryGrant.actions.length).toBe(salaryGrant.actionScopes.length);
    // other grants preserved
    expect(setArg.some((p: any) => p.module === 'attendance')).toBe(true);
  });

  it('adds a fresh salary [request_loan] self grant to a Worker role with no salary grant', async () => {
    const role = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [
        { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
        { module: 'leave', actions: ['view', 'apply_leave'], actionScopes: ['self', 'self'] },
      ],
    };
    const roleModel = buildRoleModel([role]);
    const svc = new BackfillWorkerRequestLoanGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    expect(roleModel.updateOne).toHaveBeenCalledTimes(1);
    const setArg = roleModel.updateOne.mock.calls[0][1].$set.permissions;
    const salaryGrant = setArg.find((p: any) => p.module === 'salary');
    expect(salaryGrant).toBeDefined();
    expect(salaryGrant.actions).toContain('request_loan');
    expect(salaryGrant.actionScopes[salaryGrant.actions.indexOf('request_loan')]).toBe('self');
    // existing grants preserved
    expect(setArg.some((p: any) => p.module === 'attendance')).toBe(true);
  });

  it('is idempotent: a Worker role already holding request_loan is skipped', async () => {
    const role = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [{ module: 'salary', actions: ['request_loan'], actionScopes: ['self'] }],
    };
    const roleModel = buildRoleModel([role]);
    const svc = new BackfillWorkerRequestLoanGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });
});
