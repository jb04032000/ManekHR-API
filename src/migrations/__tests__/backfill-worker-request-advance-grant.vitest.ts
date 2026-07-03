/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Backfill: seed salary.request_advance (self) onto existing seeded Worker roles.
 * Worker has no salary grant by default, so the backfill ADDS a fresh one; an
 * already-granted role is skipped (idempotent).
 * Links: backfill-worker-request-advance-grant.ts, role-seeder.constants.ts.
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
import { BackfillWorkerRequestAdvanceGrantService } from '../backfill-worker-request-advance-grant';

function buildRoleModel(roleDocs: any[]) {
  return {
    find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(roleDocs) }),
    updateOne: vi.fn().mockResolvedValue({}),
  };
}

describe('BackfillWorkerRequestAdvanceGrantService', () => {
  it('adds a fresh salary [request_advance] self grant to a Worker role with no salary grant', async () => {
    const role = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [
        { module: 'attendance', actions: ['view'], actionScopes: ['self'] },
        { module: 'leave', actions: ['view', 'apply_leave'], actionScopes: ['self', 'self'] },
      ],
    };
    const roleModel = buildRoleModel([role]);
    const svc = new BackfillWorkerRequestAdvanceGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    expect(roleModel.updateOne).toHaveBeenCalledTimes(1);
    const setArg = roleModel.updateOne.mock.calls[0][1].$set.permissions;
    const salaryGrant = setArg.find((p: any) => p.module === 'salary');
    expect(salaryGrant).toBeDefined();
    expect(salaryGrant.actions).toContain('request_advance');
    expect(salaryGrant.actionScopes[salaryGrant.actions.indexOf('request_advance')]).toBe('self');
    // existing grants preserved
    expect(setArg.some((p: any) => p.module === 'attendance')).toBe(true);
  });

  it('is idempotent: a Worker role already holding request_advance is skipped', async () => {
    const role = {
      _id: new Types.ObjectId(),
      name: 'Worker',
      permissions: [{ module: 'salary', actions: ['request_advance'], actionScopes: ['self'] }],
    };
    const roleModel = buildRoleModel([role]);
    const svc = new BackfillWorkerRequestAdvanceGrantService(roleModel as any);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });
});
