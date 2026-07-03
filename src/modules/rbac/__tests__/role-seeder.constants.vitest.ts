import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLES, DefaultRoleDefinition } from '../role-seeder.constants';
import { isValidPermissionPath } from '../permission-registry';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';

/**
 * Guards the hand-authored `permissionPaths` on the seeded system roles
 * (role redesign 2026-06-26 — Partner / Manager / Accountant / Employee, see
 * ROLE-REDESIGN-PLAN.md). A typo in a path string would otherwise ship
 * silently — the role would carry a grant the registry does not recognise, and
 * `RolesGuard` would never match it.
 */
function roleByName(name: string): DefaultRoleDefinition {
  const role = DEFAULT_ROLES.find((r) => r.name === name);
  if (!role) throw new Error(`seeded role "${name}" not found`);
  return role;
}

describe('DEFAULT_ROLES — redesigned seed set', () => {
  it('seeds exactly the four redesigned roles, in order', () => {
    expect(DEFAULT_ROLES.map((r) => r.name)).toEqual([
      'Partner',
      'Manager',
      'Accountant',
      'Employee',
    ]);
  });

  it('every seeded path is a valid registry leaf', () => {
    for (const role of DEFAULT_ROLES) {
      for (const grant of role.permissionPaths) {
        expect(isValidPermissionPath(grant.path), `${role.name}: ${grant.path}`).toBe(true);
      }
    }
  });

  it('every seeded path grant carries an explicit self/all scope', () => {
    for (const role of DEFAULT_ROLES) {
      for (const grant of role.permissionPaths) {
        expect(['self', 'all'], `${role.name}: ${grant.path}`).toContain(grant.scope);
      }
    }
  });

  it('has no duplicate path within a role', () => {
    for (const role of DEFAULT_ROLES) {
      const paths = role.permissionPaths.map((g) => g.path);
      expect(new Set(paths).size, role.name).toBe(paths.length);
    }
  });
});

// ── Partner — the new top non-owner role (replaces HR) ──────────────────────
describe('Partner role', () => {
  it('is blocked from self-edit (separation of duties)', () => {
    expect(roleByName('Partner').selfProfileEdit).toBe('block');
  });

  it('holds every sensitive Team group, member create+delete and App Access', () => {
    const paths = roleByName('Partner').permissionPaths.map((g) => g.path);
    for (const required of [
      'team.profile.pay.edit',
      'team.profile.bank.edit',
      'team.profile.statutory.edit',
      'team.profile.org.edit',
      'team.profile.documents.edit',
      'team.member.create',
      'team.member.delete',
      'team.appAccess.manage',
    ]) {
      expect(paths, required).toContain(required);
    }
  });

  it('holds the FULL finance billing surface incl. delete, send and settings', () => {
    const paths = roleByName('Partner').permissionPaths.map((g) => g.path);
    for (const required of [
      'finance.invoice.view',
      'finance.invoice.create',
      'finance.invoice.edit',
      'finance.invoice.delete',
      'finance.invoice.post',
      'finance.invoice.send',
      'finance.creditNote.create',
      'finance.expense.view',
      'finance.expense.create',
      'finance.payment.record',
      'finance.payable.view',
      'finance.payable.create',
      'finance.payable.edit',
      'finance.payable.recordPayment',
      'finance.payable.delete',
      'finance.report.view',
      'finance.gst.manage',
      'finance.settings.manage',
    ]) {
      expect(paths, required).toContain(required);
    }
  });

  it('is workspace-scoped (every path grant @all)', () => {
    expect(roleByName('Partner').permissionPaths.every((g) => g.scope === 'all')).toBe(true);
  });

  it('does NOT seed the owner-only irreversible actions', () => {
    const paths = roleByName('Partner').permissionPaths.map((g) => g.path);
    expect(paths).not.toContain('team.member.delete_permanent');
    expect(paths).not.toContain('holidays.calendar.delete');
    expect(paths).not.toContain('shifts.catalog.delete');
  });
});

// ── Manager — unchanged from the prior seed set ─────────────────────────────
describe('Manager role (unchanged)', () => {
  it('is workspace-scoped — creates members but cannot delete or manage App Access', () => {
    const mgr = roleByName('Manager');
    expect(mgr.permissionPaths.every((g) => g.scope === 'all')).toBe(true);
    const paths = mgr.permissionPaths.map((g) => g.path);
    expect(paths).toContain('team.member.create');
    expect(paths).not.toContain('team.member.delete');
    expect(paths).not.toContain('team.appAccess.manage');
    // Pay is readable but not editable; no other sensitive group.
    expect(paths).toContain('team.profile.pay.view');
    expect(paths).not.toContain('team.profile.pay.edit');
    expect(paths).not.toContain('team.profile.bank.view');
  });

  it('holds the operational finance billing paths but not the sensitive ones', () => {
    const paths = roleByName('Manager').permissionPaths.map((g) => g.path);
    for (const required of [
      'finance.invoice.view',
      'finance.invoice.create',
      'finance.invoice.edit',
      'finance.invoice.post',
      'finance.creditNote.create',
      'finance.expense.view',
      'finance.expense.create',
      'finance.payment.record',
      'finance.report.view',
      'finance.gst.manage',
    ]) {
      expect(paths, required).toContain(required);
    }
    // Void, cost-bearing send, and settings stay Partner/owner-only.
    expect(paths).not.toContain('finance.invoice.delete');
    expect(paths).not.toContain('finance.invoice.send');
    expect(paths).not.toContain('finance.settings.manage');
  });
});

// ── Employee — basic daily-worker baseline ──────────────────────────────────
describe('Employee role', () => {
  it('allows editing own profile record', () => {
    expect(roleByName('Employee').selfProfileEdit).toBe('allow');
  });

  it('is entirely self-scoped', () => {
    const emp = roleByName('Employee');
    expect(emp.permissionPaths.length).toBeGreaterThan(0);
    expect(emp.permissionPaths.every((g) => g.scope === 'self')).toBe(true);
  });

  it('is read-only on Team except its own personal contact, and never touches members', () => {
    const paths = roleByName('Employee').permissionPaths.map((g) => g.path);
    const editPaths = paths.filter((p) => p.endsWith('.edit'));
    expect(editPaths).toEqual(['team.profile.personal.edit']);
    expect(paths.some((p) => p.startsWith('team.member.'))).toBe(false);
  });

  it('drops the Karigar extras (no comp-off claim, no document edit, no finance, no salary)', () => {
    const emp = roleByName('Employee');
    const paths = emp.permissionPaths.map((g) => g.path);
    expect(paths).not.toContain('leave.compOff.apply');
    expect(paths).not.toContain('team.profile.documents.edit');
    expect(paths.some((p) => p.startsWith('finance.'))).toBe(false);
    // No salary self-service flat grants either (no advance / loan / tax).
    expect(emp.permissions.some((p) => p.module === AppModule.SALARY)).toBe(false);
  });
});

// ── Accountant — Employee baseline + full Bill & Account ────────────────────
describe('Accountant role', () => {
  it('allows editing own profile record', () => {
    expect(roleByName('Accountant').selfProfileEdit).toBe('allow');
  });

  it('shares the Employee self-service baseline verbatim (self-scoped paths)', () => {
    const accSelf = roleByName('Accountant')
      .permissionPaths.filter((g) => g.scope === 'self')
      .map((g) => g.path)
      .sort();
    const empSelf = roleByName('Employee')
      .permissionPaths.map((g) => g.path)
      .sort();
    expect(accSelf).toEqual(empSelf);
  });

  it('holds the FULL finance module at workspace scope', () => {
    const finance = roleByName('Accountant').permissionPaths.filter((g) =>
      g.path.startsWith('finance.'),
    );
    expect(finance.length).toBeGreaterThan(0);
    expect(finance.every((g) => g.scope === 'all')).toBe(true);
    const paths = finance.map((g) => g.path);
    for (const required of [
      'finance.invoice.delete',
      'finance.invoice.send',
      'finance.payable.delete',
      'finance.gst.manage',
      'finance.settings.manage',
    ]) {
      expect(paths, required).toContain(required);
    }
  });

  it('has no salary or team-management access', () => {
    const acc = roleByName('Accountant');
    expect(acc.permissions.some((p) => p.module === AppModule.SALARY)).toBe(false);
    const paths = acc.permissionPaths.map((g) => g.path);
    expect(paths.some((p) => p.startsWith('team.member.'))).toBe(false);
  });
});

// ── Salary flat-grant contract across the seeded roles ──────────────────────
// Salary stays on the legacy flat (module, action, scope) model. Pin the exact
// "principle of least privilege" salary contract per role so a future role-
// seeder edit cannot accidentally broaden it. The detailed Manager ordering +
// negative contract lives in role-seeder.salary.vitest.ts.
describe('DEFAULT_ROLES flat salary grants', () => {
  function salaryGrant(role: DefaultRoleDefinition) {
    return role.permissions.find((p) => p.module === AppModule.SALARY);
  }

  it('Partner holds VIEW + EDIT + SENSITIVE_VIEW + DECLARE_TAX, all @all', () => {
    const grant = salaryGrant(roleByName('Partner'));
    expect(grant, 'Partner salary grant').toBeDefined();
    for (const action of [
      ModuleAction.VIEW,
      ModuleAction.EDIT,
      ModuleAction.SENSITIVE_VIEW,
      ModuleAction.DECLARE_TAX,
    ]) {
      const idx = grant.actions.indexOf(action);
      expect(idx, `Partner has ${action}`).toBeGreaterThanOrEqual(0);
      expect(grant.actionScopes?.[idx]).toBe('all');
    }
  });

  it('Accountant + Employee get NO salary grant (baseline stays salary-free)', () => {
    expect(salaryGrant(roleByName('Accountant'))).toBeUndefined();
    expect(salaryGrant(roleByName('Employee'))).toBeUndefined();
  });
});
