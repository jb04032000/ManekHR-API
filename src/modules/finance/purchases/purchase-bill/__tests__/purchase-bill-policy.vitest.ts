/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Finance/Bills hardening — PurchaseBillPolicyService maker-checker exemption
 * (spec OQ-FB-5 / Finance/Bills hardening Pillar 2).
 *
 * Covers:
 *  - Workspace owner (ownerId on workspace.ownerId) is exempt without further
 *    role lookup (short-circuit path).
 *  - An active member with HR role (finance.settings.manage grant) is exempt.
 *  - An active member with Manager role (no finance.settings.manage) is NOT exempt.
 *  - An inactive / missing member is NOT exempt (fail-closed).
 *  - A missing workspace is NOT exempt (fail-closed).
 *
 * Role-preset structural check:
 *  - Worker preset has ZERO finance.payable.* paths (AC-2.3).
 *  - Manager preset has finance.payable.view/create/edit/recordPayment but NOT delete.
 *  - HR preset has all five finance.payable.* paths incl. delete.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { PurchaseBillPolicyService } from '../purchase-bill-policy.service';
import { DEFAULT_ROLES } from '../../../../rbac/role-seeder.constants';

// Valid 24-char hex ObjectIds.
const WS_ID = '6a2f26baca75116b4eee1c80';
const OWNER_USER = '6a2f26baca75116b4eee1c81';
const MANAGER_USER = '6a2f26baca75116b4eee1c82';
const HR_USER = '6a2f26baca75116b4eee1c83';
const ROLE_HR = '6a2f26baca75116b4eee1c84';
const ROLE_MANAGER = '6a2f26baca75116b4eee1c85';

// Build a policy service with injectable model stubs.
function buildPolicy(overrides: { workspace?: any; member?: any; role?: any; teamMember?: any }) {
  const leanExec = (val: any) => ({ lean: () => ({ exec: () => Promise.resolve(val) }) });

  const workspaceModel: any = {
    findById: vi.fn().mockReturnValue(leanExec(overrides.workspace ?? null)),
  };
  const memberModel: any = {
    findOne: vi.fn().mockReturnValue(leanExec(overrides.member ?? null)),
  };
  const roleModel: any = {
    findOne: vi.fn().mockReturnValue(leanExec(overrides.role ?? null)),
  };
  const teamMemberModel: any = {
    findOne: vi.fn().mockReturnValue({
      select: () => leanExec(overrides.teamMember ?? null),
    }),
  };

  return new PurchaseBillPolicyService(workspaceModel, memberModel, roleModel, teamMemberModel);
}

describe('PurchaseBillPolicyService.isExemptFromMakerChecker', () => {
  it('returns TRUE for the workspace owner (short-circuit — no role lookup)', async () => {
    const svc = buildPolicy({
      workspace: { _id: WS_ID, ownerId: OWNER_USER }, // owner matches
    });
    expect(await svc.isExemptFromMakerChecker(WS_ID, OWNER_USER)).toBe(true);
  });

  it('returns TRUE for an HR member who holds finance.settings.manage', async () => {
    const svc = buildPolicy({
      workspace: { _id: WS_ID, ownerId: 'someone_else' }, // not the owner
      member: { roleId: ROLE_HR, status: 'active' },
      role: {
        _id: ROLE_HR,
        permissionPaths: [
          { path: 'finance.settings.manage', scope: 'all' },
          { path: 'finance.payable.view', scope: 'all' },
        ],
      },
    });
    expect(await svc.isExemptFromMakerChecker(WS_ID, HR_USER)).toBe(true);
  });

  it('returns FALSE for a Manager who lacks finance.settings.manage', async () => {
    const svc = buildPolicy({
      workspace: { _id: WS_ID, ownerId: 'someone_else' },
      member: { roleId: ROLE_MANAGER, status: 'active' },
      role: {
        _id: ROLE_MANAGER,
        permissionPaths: [
          // Manager does NOT hold finance.settings.manage — that is HR-only.
          { path: 'finance.payable.view', scope: 'all' },
          { path: 'finance.payable.create', scope: 'all' },
          { path: 'finance.payable.edit', scope: 'all' },
          { path: 'finance.payable.recordPayment', scope: 'all' },
        ],
      },
    });
    expect(await svc.isExemptFromMakerChecker(WS_ID, MANAGER_USER)).toBe(false);
  });

  it('returns FALSE (fail-closed) when the workspace is not found', async () => {
    const svc = buildPolicy({ workspace: null });
    expect(await svc.isExemptFromMakerChecker(WS_ID, HR_USER)).toBe(false);
  });

  it('returns FALSE (fail-closed) when the member record is missing or inactive', async () => {
    const svc = buildPolicy({
      workspace: { _id: WS_ID, ownerId: 'someone_else' },
      member: null, // member not found
    });
    expect(await svc.isExemptFromMakerChecker(WS_ID, MANAGER_USER)).toBe(false);
  });

  it('returns FALSE (fail-closed) when the role document is missing', async () => {
    const svc = buildPolicy({
      workspace: { _id: WS_ID, ownerId: 'someone_else' },
      member: { roleId: ROLE_MANAGER, status: 'active' },
      role: null, // role not found
    });
    expect(await svc.isExemptFromMakerChecker(WS_ID, MANAGER_USER)).toBe(false);
  });
});

describe('Role presets — finance.payable.* grant coverage (AC-2.3 / OQ-FB-2)', () => {
  function payablePathsFor(roleName: string): string[] {
    const preset = DEFAULT_ROLES.find((r) => r.name === roleName);
    return (preset?.permissionPaths ?? [])
      .filter((g) => g.path.startsWith('finance.payable.'))
      .map((g) => g.path);
  }

  it('Worker role has ZERO finance.payable paths (Karigar cannot access Bills)', () => {
    const paths = payablePathsFor('Worker');
    expect(paths).toHaveLength(0);
  });

  it('Member role has ZERO finance.payable paths', () => {
    const paths = payablePathsFor('Member');
    expect(paths).toHaveLength(0);
  });

  it('Manager role has view/create/edit/recordPayment but NOT delete', () => {
    const paths = payablePathsFor('Manager');
    expect(paths).toContain('finance.payable.view');
    expect(paths).toContain('finance.payable.create');
    expect(paths).toContain('finance.payable.edit');
    expect(paths).toContain('finance.payable.recordPayment');
    // delete is HR-only — a Manager cannot soft-delete a statutory bill.
    expect(paths).not.toContain('finance.payable.delete');
  });

  it('HR role has ALL five finance.payable paths including sensitive delete', () => {
    const paths = payablePathsFor('HR');
    expect(paths).toContain('finance.payable.view');
    expect(paths).toContain('finance.payable.create');
    expect(paths).toContain('finance.payable.edit');
    expect(paths).toContain('finance.payable.recordPayment');
    expect(paths).toContain('finance.payable.delete');
  });

  it('HR role also holds finance.settings.manage (the maker-checker exemption sentinel)', () => {
    const preset = DEFAULT_ROLES.find((r) => r.name === 'HR');
    const hasManage = (preset?.permissionPaths ?? []).some(
      (g) => g.path === 'finance.settings.manage',
    );
    expect(hasManage).toBe(true);
  });

  it('Manager role does NOT hold finance.settings.manage (not exempt from maker-checker)', () => {
    const preset = DEFAULT_ROLES.find((r) => r.name === 'Manager');
    const hasManage = (preset?.permissionPaths ?? []).some(
      (g) => g.path === 'finance.settings.manage',
    );
    expect(hasManage).toBe(false);
  });
});
