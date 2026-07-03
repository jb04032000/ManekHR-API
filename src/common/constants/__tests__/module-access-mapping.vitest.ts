import { describe, it, expect } from 'vitest';
import { buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

/**
 * Locks the owner-CONFIRMED per-tier MODULE ENABLE map produced by
 * `buildModuleAccess(tier)`. This is the canonical source of a subscription's
 * effective module access (appliedEntitlements.moduleAccess), so a regression
 * here silently grants or strips paid modules. Kept in sync with the
 * `moduleList` enable flags + `_NEW_MODULE_TIER_DEFAULTS` sub-feature blocks
 * in module-features.registry.ts.
 *
 * Confirmed mapping (cumulative; enterprise = retired legacy tier == business+):
 *   SHIFTS         on for ALL tiers (free = "basic": create/edit/delete LOCKED)
 *   LEAVE          starter+ (was growth+)
 *   REGULARIZATION starter+ (was growth+)
 *   MANUFACTURING  business+ (was growth+)
 *   JOB_WORK       business+ (was growth+)
 *   DOWNTIME       business+ (was growth+)
 *   MAINTENANCE    business+ (was enterprise-only)
 *   SALARY         on for all; statutory payroll FULL only growth+ (sub-feature)
 */

// Maps module -> enabled flag for a given tier.
const enabledMap = (tier: string): Record<string, boolean> =>
  Object.fromEntries(buildModuleAccess(tier).map((m) => [m.module, m.enabled]));

// Finds a module's subFeature access level for a given tier (undefined if absent).
const subAccess = (
  tier: string,
  module: AppModule,
  key: string,
): FeatureAccessLevel | undefined => {
  const mod = buildModuleAccess(tier).find((m) => m.module === module);
  return mod?.subFeatures.find((sf) => sf.key === key)?.access;
};

describe('buildModuleAccess — confirmed per-tier module ENABLE map', () => {
  describe('free', () => {
    const en = enabledMap('free');
    it('enables SHIFTS (basic shifts), TEAM, ATTENDANCE, SALARY', () => {
      expect(en[AppModule.SHIFTS]).toBe(true);
      expect(en[AppModule.TEAM]).toBe(true);
      expect(en[AppModule.ATTENDANCE]).toBe(true);
      expect(en[AppModule.SALARY]).toBe(true);
    });
    it('disables LEAVE / REGULARIZATION / MANUFACTURING on free', () => {
      expect(en[AppModule.LEAVE]).toBe(false);
      expect(en[AppModule.REGULARIZATION]).toBe(false);
      expect(en[AppModule.MANUFACTURING]).toBe(false);
    });
  });

  describe('starter', () => {
    const en = enabledMap('starter');
    it('enables LEAVE, REGULARIZATION, SHIFTS', () => {
      expect(en[AppModule.LEAVE]).toBe(true);
      expect(en[AppModule.REGULARIZATION]).toBe(true);
      expect(en[AppModule.SHIFTS]).toBe(true);
    });
    it('keeps production cluster OFF (business+ only)', () => {
      expect(en[AppModule.MANUFACTURING]).toBe(false);
      expect(en[AppModule.JOB_WORK]).toBe(false);
      expect(en[AppModule.DOWNTIME]).toBe(false);
      expect(en[AppModule.MAINTENANCE]).toBe(false);
    });
  });

  describe('growth', () => {
    const en = enabledMap('growth');
    it('enables LEAVE but keeps production cluster OFF', () => {
      expect(en[AppModule.LEAVE]).toBe(true);
      expect(en[AppModule.MANUFACTURING]).toBe(false);
      expect(en[AppModule.JOB_WORK]).toBe(false);
      expect(en[AppModule.DOWNTIME]).toBe(false);
      expect(en[AppModule.MAINTENANCE]).toBe(false);
    });
  });

  describe('business', () => {
    const en = enabledMap('business');
    it('enables the full production cluster + LEAVE', () => {
      expect(en[AppModule.MANUFACTURING]).toBe(true);
      expect(en[AppModule.JOB_WORK]).toBe(true);
      expect(en[AppModule.DOWNTIME]).toBe(true);
      expect(en[AppModule.MAINTENANCE]).toBe(true);
      expect(en[AppModule.LEAVE]).toBe(true);
    });
  });

  describe('custom', () => {
    const en = enabledMap('custom');
    it('enables MANUFACTURING, MAINTENANCE, LEAVE', () => {
      expect(en[AppModule.MANUFACTURING]).toBe(true);
      expect(en[AppModule.MAINTENANCE]).toBe(true);
      expect(en[AppModule.LEAVE]).toBe(true);
    });
  });

  describe('enterprise (retired legacy tier == business+)', () => {
    it('still resolves MANUFACTURING enabled', () => {
      expect(enabledMap('enterprise')[AppModule.MANUFACTURING]).toBe(true);
    });
  });
});

describe('buildModuleAccess — sub-feature gates that ride alongside ENABLE', () => {
  it('free SHIFTS is "basic": create_shift LOCKED', () => {
    expect(subAccess('free', AppModule.SHIFTS, 'create_shift')).toBe(FeatureAccessLevel.LOCKED);
  });

  it('SALARY statutory_compliance: LOCKED on free/starter, FULL at growth (full payroll growth+)', () => {
    expect(subAccess('free', AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.LOCKED,
    );
    expect(subAccess('starter', AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.LOCKED,
    );
    expect(subAccess('growth', AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.FULL,
    );
  });

  it('starter LEAVE is usable: apply === FULL (not enabled-but-empty)', () => {
    expect(subAccess('starter', AppModule.LEAVE, 'apply')).toBe(FeatureAccessLevel.FULL);
  });

  it('starter REGULARIZATION is usable: request === FULL', () => {
    expect(subAccess('starter', AppModule.REGULARIZATION, 'request')).toBe(FeatureAccessLevel.FULL);
  });
});
