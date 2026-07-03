import { describe, it, expect } from 'vitest';
import { MODULE_FEATURES_REGISTRY, buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';
import { validateModuleAccess } from '../../../modules/subscriptions/dto/subscription.dto';

/**
 * Gating bug class (2026-07-02): sub-feature keys enforced by @RequireSubscription
 * but MISSING from the feature registries could never be granted from the admin
 * plan editor -> permanent 403. This batch closes four such gaps:
 *   MACHINES.piece_rate_payroll (salary.controller piece-rate + team.controller)
 *   SALARY.loan_management / bonus_tracking / daily_wage_ledger (salary/loan-request)
 * Keep in sync with the web registry (web/lib/constants/feature-access.registry.ts).
 */

const machinesDef = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.MACHINES);
const salaryDef = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.SALARY);

function machinesSub(tier: string, key: string) {
  const m = buildModuleAccess(tier).find((x) => x.module === AppModule.MACHINES);
  return m?.subFeatures.find((s) => s.key === key)?.access;
}
function salarySub(tier: string, key: string) {
  const m = buildModuleAccess(tier).find((x) => x.module === AppModule.SALARY);
  return m?.subFeatures.find((s) => s.key === key)?.access;
}

// ── MACHINES.piece_rate_payroll ──────────────────────────────────────────────
describe('MACHINES piece_rate_payroll gap', () => {
  it('is catalogued under the MACHINES module (supportsLimited false, non-empty label)', () => {
    const sf = machinesDef?.subFeatures.find((s) => s.key === 'piece_rate_payroll');
    expect(sf).toBeDefined();
    expect(sf?.supportsLimited).toBe(false);
    expect((sf?.label ?? '').length).toBeGreaterThan(0);
  });

  it('validateModuleAccess accepts a MACHINES piece_rate_payroll full grant', () => {
    const res = validateModuleAccess([
      {
        module: AppModule.MACHINES,
        enabled: true,
        subFeatures: [{ key: 'piece_rate_payroll', access: FeatureAccessLevel.FULL }],
      },
    ] as any);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('is NOT auto-granted by any tier (MACHINES omitted from buildModuleAccess -> empty-array grandfather stays FULL)', () => {
    for (const tier of ['free', 'starter', 'growth', 'business', 'custom']) {
      expect(machinesSub(tier, 'piece_rate_payroll')).toBeUndefined();
    }
  });
});

// ── SALARY.loan_management / bonus_tracking / daily_wage_ledger ───────────────
const SALARY_KEYS = ['loan_management', 'bonus_tracking', 'daily_wage_ledger'];

describe('SALARY sub-feature gaps', () => {
  it.each(SALARY_KEYS)('catalogues %s under the SALARY module (supportsLimited false)', (key) => {
    const sf = salaryDef?.subFeatures.find((s) => s.key === key);
    expect(sf, key).toBeDefined();
    expect(sf?.supportsLimited, key).toBe(false);
    expect((sf?.label ?? '').length, key).toBeGreaterThan(0);
  });

  it.each(SALARY_KEYS)('validateModuleAccess accepts a SALARY %s full grant', (key) => {
    const res = validateModuleAccess([
      {
        module: AppModule.SALARY,
        enabled: true,
        subFeatures: [{ key, access: FeatureAccessLevel.FULL }],
      },
    ] as any);
    expect(res.valid, key).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // Tier-default decision (no-regression): mirror the closest sibling paid-salary
  // cluster (advance_payments / split_payments / bulk_payments / commission_tracking
  // / salary_increments) = LOCKED on free, FULL on every paid tier. Free stays
  // locked (no change from today, where the key was absent -> guard 403). Paid tiers
  // gain the access they were erroneously denied. No existing salary key changes.
  it.each(SALARY_KEYS)('free tier: %s is LOCKED', (key) => {
    expect(salarySub('free', key), key).toBe(FeatureAccessLevel.LOCKED);
  });

  it.each(SALARY_KEYS)('paid tiers grant %s FULL', (key) => {
    for (const tier of ['starter', 'pro', 'growth', 'business', 'enterprise', 'custom']) {
      expect(salarySub(tier, key), `${tier}/${key}`).toBe(FeatureAccessLevel.FULL);
    }
  });

  // Regression: the closest sibling defaults are untouched by this change.
  it('leaves sibling salary tier defaults unchanged (advance_payments/commission_tracking)', () => {
    expect(salarySub('free', 'advance_payments')).toBe(FeatureAccessLevel.LOCKED);
    expect(salarySub('starter', 'advance_payments')).toBe(FeatureAccessLevel.FULL);
    expect(salarySub('free', 'commission_tracking')).toBe(FeatureAccessLevel.LOCKED);
    expect(salarySub('starter', 'commission_tracking')).toBe(FeatureAccessLevel.FULL);
    expect(salarySub('starter', 'statutory_compliance')).toBe(FeatureAccessLevel.LOCKED);
  });
});
