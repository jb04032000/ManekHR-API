import { describe, it, expect } from 'vitest';

import { buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

// ---------------------------------------------------------------------------
// Pure-function test of buildModuleAccess(tier).
//
// This encodes the owner-confirmed plan -> module map (Phase 1, cumulative):
//   • Free      — Team, Attendance(basic), SHIFTS(basic), basic Salary.
//   • Starter   — + Leave, Holidays, Regularization, full Attendance/Shifts.
//   • Growth    — + full payroll (salary statutory / payslips). NO production.
//   • Business  — + Manufacturing / Job Work / Downtime / Maintenance.
//   • Custom    — everything.
//
// buildModuleAccess is a pure export (no Mongoose), so NO @nestjs/mongoose
// decorator stub is needed here — we import it directly.
// ---------------------------------------------------------------------------

type ModuleAccess = ReturnType<typeof buildModuleAccess>;

function findModule(access: ModuleAccess, module: AppModule) {
  return access.find((m) => m.module === module);
}

function isEnabled(access: ModuleAccess, module: AppModule): boolean | undefined {
  return findModule(access, module)?.enabled;
}

function subFeatureAccess(
  access: ModuleAccess,
  module: AppModule,
  key: string,
): string | undefined {
  return findModule(access, module)?.subFeatures.find((sf) => sf.key === key)?.access;
}

const PRODUCTION_MODULES = [
  AppModule.MANUFACTURING,
  AppModule.JOB_WORK,
  AppModule.DOWNTIME,
  AppModule.MAINTENANCE,
];

describe('buildModuleAccess — owner-confirmed plan -> module mapping (Phase 1)', () => {
  // --- FREE -----------------------------------------------------------------
  describe('free tier', () => {
    const access = buildModuleAccess('free');

    it('Shifts is enabled (basic visibility) on free', () => {
      expect(isEnabled(access, AppModule.SHIFTS)).toBe(true);
    });

    it('Shift template management (create/edit/delete) stays LOCKED on free', () => {
      expect(subFeatureAccess(access, AppModule.SHIFTS, 'create_shift')).toBe(
        FeatureAccessLevel.LOCKED,
      );
      expect(subFeatureAccess(access, AppModule.SHIFTS, 'edit_shift')).toBe(
        FeatureAccessLevel.LOCKED,
      );
      expect(subFeatureAccess(access, AppModule.SHIFTS, 'delete_shift')).toBe(
        FeatureAccessLevel.LOCKED,
      );
    });

    it('Leave and Regularization are DISABLED on free', () => {
      expect(isEnabled(access, AppModule.LEAVE)).toBe(false);
      expect(isEnabled(access, AppModule.REGULARIZATION)).toBe(false);
    });

    it('Production cluster (Manufacturing/JobWork/Downtime/Maintenance) is DISABLED on free', () => {
      for (const mod of PRODUCTION_MODULES) {
        expect(isEnabled(access, mod)).toBe(false);
      }
    });

    it('Salary statutory_compliance is LOCKED on free (basic salary only)', () => {
      expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
        FeatureAccessLevel.LOCKED,
      );
    });
  });

  // --- STARTER --------------------------------------------------------------
  describe('starter tier', () => {
    const access = buildModuleAccess('starter');

    it('Shifts is enabled on starter', () => {
      expect(isEnabled(access, AppModule.SHIFTS)).toBe(true);
    });

    it('Leave is enabled with non-empty FULL sub-features', () => {
      const leave = findModule(access, AppModule.LEAVE);
      expect(leave?.enabled).toBe(true);
      expect(leave?.subFeatures.length ?? 0).toBeGreaterThan(0);
      // Every leave sub-feature granted at starter must be FULL.
      for (const sf of leave?.subFeatures ?? []) {
        expect(sf.access).toBe(FeatureAccessLevel.FULL);
      }
      // Spot-check the canonical leave keys.
      expect(subFeatureAccess(access, AppModule.LEAVE, 'apply')).toBe(FeatureAccessLevel.FULL);
      expect(subFeatureAccess(access, AppModule.LEAVE, 'approve')).toBe(FeatureAccessLevel.FULL);
      expect(subFeatureAccess(access, AppModule.LEAVE, 'view_balance')).toBe(
        FeatureAccessLevel.FULL,
      );
      expect(subFeatureAccess(access, AppModule.LEAVE, 'configure')).toBe(FeatureAccessLevel.FULL);
    });

    it('Regularization is enabled with non-empty FULL sub-features', () => {
      const reg = findModule(access, AppModule.REGULARIZATION);
      expect(reg?.enabled).toBe(true);
      expect(reg?.subFeatures.length ?? 0).toBeGreaterThan(0);
      for (const sf of reg?.subFeatures ?? []) {
        expect(sf.access).toBe(FeatureAccessLevel.FULL);
      }
      expect(subFeatureAccess(access, AppModule.REGULARIZATION, 'request')).toBe(
        FeatureAccessLevel.FULL,
      );
    });

    it('Production cluster is still DISABLED on starter', () => {
      for (const mod of PRODUCTION_MODULES) {
        expect(isEnabled(access, mod)).toBe(false);
      }
    });

    it('Salary statutory_compliance is still LOCKED on starter (basic salary kept)', () => {
      expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
        FeatureAccessLevel.LOCKED,
      );
    });
  });

  // --- GROWTH ---------------------------------------------------------------
  describe('growth tier', () => {
    const access = buildModuleAccess('growth');

    it('Leave and Regularization remain enabled (cumulative from starter)', () => {
      expect(isEnabled(access, AppModule.LEAVE)).toBe(true);
      expect(isEnabled(access, AppModule.REGULARIZATION)).toBe(true);
    });

    it('Production cluster is DISABLED on growth (production is business+)', () => {
      for (const mod of PRODUCTION_MODULES) {
        expect(isEnabled(access, mod)).toBe(false);
      }
    });

    it('Full payroll unlocks: statutory_compliance + payslip_generation are FULL', () => {
      expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
        FeatureAccessLevel.FULL,
      );
      expect(subFeatureAccess(access, AppModule.SALARY, 'payslip_generation')).toBe(
        FeatureAccessLevel.FULL,
      );
    });
  });

  // --- BUSINESS -------------------------------------------------------------
  describe('business tier', () => {
    const access = buildModuleAccess('business');

    it('Production cluster is ENABLED on business', () => {
      for (const mod of PRODUCTION_MODULES) {
        expect(isEnabled(access, mod)).toBe(true);
      }
    });

    it('Salary statutory_compliance stays FULL (cumulative from growth)', () => {
      expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
        FeatureAccessLevel.FULL,
      );
    });
  });

  // --- CUSTOM ---------------------------------------------------------------
  describe('custom tier', () => {
    const access = buildModuleAccess('custom');

    it('everything is enabled — Shifts/Leave/Regularization/production + statutory FULL', () => {
      expect(isEnabled(access, AppModule.SHIFTS)).toBe(true);
      expect(isEnabled(access, AppModule.LEAVE)).toBe(true);
      expect(isEnabled(access, AppModule.REGULARIZATION)).toBe(true);
      for (const mod of PRODUCTION_MODULES) {
        expect(isEnabled(access, mod)).toBe(true);
      }
      expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
        FeatureAccessLevel.FULL,
      );
    });
  });
});
