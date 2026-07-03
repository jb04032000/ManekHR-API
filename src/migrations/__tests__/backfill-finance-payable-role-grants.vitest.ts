/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { BackfillFinancePayableRoleGrantsService } from '../backfill-finance-payable-role-grants';

/**
 * Finance/Bills hardening migration 0042 (OQ-FB-2) — finance.payable.* grant
 * backfill onto existing seeded Manager/HR roles. Pins:
 *   - Manager gets view/create/edit/recordPayment but NOT delete (HR-only);
 *   - HR gets all five incl. delete;
 *   - Worker/Member (no finance preset) are NOT widened;
 *   - existing paths are preserved (UNION, not clobber);
 *   - empty-permissionPaths roles are skipped (owned by the populate-once backfill);
 *   - idempotent (a re-run writes nothing).
 */
describe('BackfillFinancePayableRoleGrantsService (migration 0042)', () => {
  let roleModel: any;
  let svc: BackfillFinancePayableRoleGrantsService;

  beforeEach(() => {
    roleModel = { find: vi.fn(), updateOne: vi.fn().mockResolvedValue({}) };
    svc = new BackfillFinancePayableRoleGrantsService(roleModel);
  });

  function findReturns(roles: any[]) {
    roleModel.find.mockReturnValue({ exec: vi.fn().mockResolvedValue(roles) });
  }

  it('adds Manager payable paths (view/create/edit/recordPayment) but NOT delete', async () => {
    findReturns([
      {
        _id: 'r1',
        name: 'Manager',
        isSystem: true,
        permissionPaths: [{ path: 'finance.invoice.view', scope: 'all' }],
      },
    ]);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    const [, update] = roleModel.updateOne.mock.calls[0];
    const paths: string[] = update.$set.permissionPaths.map((g: any) => g.path);
    expect(paths).toContain('finance.payable.view');
    expect(paths).toContain('finance.payable.create');
    expect(paths).toContain('finance.payable.edit');
    expect(paths).toContain('finance.payable.recordPayment');
    // delete is HR/owner-only — Manager must NOT receive it.
    expect(paths).not.toContain('finance.payable.delete');
    // Existing path preserved (UNION).
    expect(paths).toContain('finance.invoice.view');
  });

  it('adds ALL payable paths incl. delete to Partner', async () => {
    findReturns([
      {
        _id: 'r2',
        name: 'Partner',
        isSystem: true,
        permissionPaths: [{ path: 'team.directory.view', scope: 'all' }],
      },
    ]);

    await svc.run();
    const [, update] = roleModel.updateOne.mock.calls[0];
    const paths: string[] = update.$set.permissionPaths.map((g: any) => g.path);
    expect(paths).toContain('finance.payable.delete');
    expect(paths).toContain('finance.payable.recordPayment');
  });

  it('does NOT widen Worker/Member (no finance preset)', async () => {
    findReturns([
      {
        _id: 'r3',
        name: 'Worker',
        isSystem: true,
        permissionPaths: [{ path: 'team.directory.view', scope: 'self' }],
      },
      {
        _id: 'r4',
        name: 'Member',
        isSystem: true,
        permissionPaths: [{ path: 'team.directory.view', scope: 'self' }],
      },
    ]);

    const result = await svc.run();
    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('skips a role with empty permissionPaths (owned by the populate-once backfill)', async () => {
    findReturns([{ _id: 'r5', name: 'Manager', isSystem: true, permissionPaths: [] }]);
    const result = await svc.run();
    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('does NOT touch a custom (non-system) role', async () => {
    findReturns([
      {
        _id: 'r6',
        name: 'Accounts Clerk',
        isSystem: false,
        permissionPaths: [{ path: 'finance.invoice.view', scope: 'all' }],
      },
    ]);
    const result = await svc.run();
    expect(result.rolesUpdated).toBe(0);
  });

  it('is idempotent — a second pass over an already-backfilled role writes nothing', async () => {
    findReturns([
      {
        _id: 'r7',
        name: 'HR',
        isSystem: true,
        permissionPaths: [
          { path: 'finance.payable.view', scope: 'all' },
          { path: 'finance.payable.create', scope: 'all' },
          { path: 'finance.payable.edit', scope: 'all' },
          { path: 'finance.payable.recordPayment', scope: 'all' },
          { path: 'finance.payable.delete', scope: 'all' },
        ],
      },
    ]);
    const result = await svc.run();
    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });
});
