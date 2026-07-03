import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PARTNER_ROLE,
  DEFAULT_MANAGER_ROLE,
  DEFAULT_ACCOUNTANT_ROLE,
  DEFAULT_EMPLOYEE_ROLE,
  type DefaultRoleDefinition,
} from '../role-seeder.constants';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';

/**
 * Role-seeder salary permission contract (role redesign 2026-06-26, see
 * ROLE-REDESIGN-PLAN.md).
 *
 * Pins the exact salary grants the seeded roles carry, so a future edit cannot
 * silently broaden a preset:
 *   - Partner:    salary VIEW + EDIT + SENSITIVE_VIEW + DECLARE_TAX — all @all
 *                 (replaces HR; the full payroll surface).
 *   - Manager:    salary VIEW@all + REVIEW_ADVANCE@self only; NO EDIT /
 *                 SENSITIVE_VIEW / DECLARE_TAX (unchanged).
 *   - Accountant: NO salary grant (owns the books, not payroll).
 *   - Employee:   NO salary grant (no advance / 0% loan / tax self-service).
 */

function hasAction(role: DefaultRoleDefinition, action: ModuleAction, scope: string): boolean {
  for (const p of role.permissions) {
    if (p.module !== AppModule.SALARY) continue;
    for (let i = 0; i < p.actions.length; i++) {
      if (p.actions[i] === action && p.actionScopes[i] === scope) return true;
    }
  }
  return false;
}

function lacksAction(role: DefaultRoleDefinition, action: ModuleAction): boolean {
  for (const p of role.permissions) {
    if (p.module !== AppModule.SALARY) continue;
    if (p.actions.includes(action)) return false;
  }
  return true;
}

function hasNoSalaryGrant(role: DefaultRoleDefinition): boolean {
  return !role.permissions.some((p) => p.module === AppModule.SALARY);
}

describe('Role seeder — salary grant contract (role redesign)', () => {
  describe('Partner role (replaces HR)', () => {
    it('has salary VIEW@all', () => {
      expect(hasAction(DEFAULT_PARTNER_ROLE, ModuleAction.VIEW, 'all')).toBe(true);
    });

    it('has salary EDIT@all', () => {
      expect(hasAction(DEFAULT_PARTNER_ROLE, ModuleAction.EDIT, 'all')).toBe(true);
    });

    it('has salary SENSITIVE_VIEW@all (PAN/bank access)', () => {
      expect(hasAction(DEFAULT_PARTNER_ROLE, ModuleAction.SENSITIVE_VIEW, 'all')).toBe(true);
    });

    it('has DECLARE_TAX@all (can upsert + lock any member declaration)', () => {
      expect(hasAction(DEFAULT_PARTNER_ROLE, ModuleAction.DECLARE_TAX, 'all')).toBe(true);
    });
  });

  describe('Manager role (unchanged)', () => {
    it('has salary VIEW@all', () => {
      expect(hasAction(DEFAULT_MANAGER_ROLE, ModuleAction.VIEW, 'all')).toBe(true);
    });

    it('has REVIEW_ADVANCE@self (Phase 3a reporting-person advance review)', () => {
      // Manager verifies their direct reports' advance requests. Scope is 'self'
      // (reportsTo-filtered read, not a new RBAC scope) even though salary VIEW
      // is 'all' — hence a separate salary permission row.
      expect(hasAction(DEFAULT_MANAGER_ROLE, ModuleAction.REVIEW_ADVANCE, 'self')).toBe(true);
    });

    it('keeps salary VIEW@all resolvable as the FIRST salary row (effectiveScope ordering)', () => {
      // CallerScopeService.effectiveScope returns on the first matching module
      // row, so the REVIEW_ADVANCE row must NOT precede the VIEW row or
      // salary.view scope resolution in salary.service would break.
      const salaryRows = DEFAULT_MANAGER_ROLE.permissions.filter(
        (p) => p.module === AppModule.SALARY,
      );
      const viewRowIdx = salaryRows.findIndex((p) => p.actions.includes(ModuleAction.VIEW));
      const reviewRowIdx = salaryRows.findIndex((p) =>
        p.actions.includes(ModuleAction.REVIEW_ADVANCE),
      );
      expect(viewRowIdx).toBeGreaterThanOrEqual(0);
      expect(reviewRowIdx).toBeGreaterThan(viewRowIdx);
    });

    it('does NOT have salary EDIT (Manager cannot create/change payroll values)', () => {
      expect(lacksAction(DEFAULT_MANAGER_ROLE, ModuleAction.EDIT)).toBe(true);
    });

    it('does NOT have SENSITIVE_VIEW (bank/PAN gate — Partner-only)', () => {
      expect(lacksAction(DEFAULT_MANAGER_ROLE, ModuleAction.SENSITIVE_VIEW)).toBe(true);
    });

    it('does NOT have DECLARE_TAX (Manager declares via Partner, not self-service)', () => {
      expect(lacksAction(DEFAULT_MANAGER_ROLE, ModuleAction.DECLARE_TAX)).toBe(true);
    });
  });

  describe('Accountant + Employee roles', () => {
    it('Accountant carries no salary grant (owns the books, not payroll)', () => {
      expect(hasNoSalaryGrant(DEFAULT_ACCOUNTANT_ROLE)).toBe(true);
    });

    it('Employee carries no salary grant (no advance / 0% loan / tax self-service)', () => {
      expect(hasNoSalaryGrant(DEFAULT_EMPLOYEE_ROLE)).toBe(true);
    });
  });
});
