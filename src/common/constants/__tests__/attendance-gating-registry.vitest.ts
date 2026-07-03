import { describe, it, expect } from 'vitest';
import { MODULE_FEATURES_REGISTRY, buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

const KEYS = ['attendance_muster', 'overtime_analytics', 'compliance_report', 'absence_patterns'];

function attendanceSub(tier: string, key: string) {
  const access = buildModuleAccess(tier);
  const att = access.find((m) => m.module === AppModule.ATTENDANCE);
  return att?.subFeatures.find((s) => s.key === key)?.access;
}

describe('attendance feature-gating registry', () => {
  it('catalogues all 4 keys under the attendance module', () => {
    const att = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.ATTENDANCE);
    for (const key of KEYS) {
      const sub = att?.subFeatures.find((s) => s.key === key);
      expect(sub, key).toBeDefined();
      expect(sub?.supportsLimited, key).toBe(false);
    }
  });

  it('free tier: all 4 LOCKED', () => {
    for (const key of KEYS) {
      expect(attendanceSub('free', key), key).toBe(FeatureAccessLevel.LOCKED);
    }
  });

  it('starter tier: attendance_muster FULL, the 3 analytics LOCKED', () => {
    expect(attendanceSub('starter', 'attendance_muster')).toBe(FeatureAccessLevel.FULL);
    for (const key of ['overtime_analytics', 'compliance_report', 'absence_patterns']) {
      expect(attendanceSub('starter', key), key).toBe(FeatureAccessLevel.LOCKED);
    }
  });

  it('pro/growth/business/enterprise/custom: all 4 FULL', () => {
    for (const tier of ['pro', 'growth', 'business', 'enterprise', 'custom']) {
      for (const key of KEYS) {
        expect(attendanceSub(tier, key), `${tier}/${key}`).toBe(FeatureAccessLevel.FULL);
      }
    }
  });
});
