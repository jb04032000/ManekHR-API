import { describe, it, expect } from 'vitest';
import { MODULE_FEATURES_REGISTRY, buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

describe('defaulter_alerts feature registry', () => {
  it('is catalogued under the attendance module', () => {
    const attendance = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.ATTENDANCE);
    const sub = attendance?.subFeatures.find((s) => s.key === 'defaulter_alerts');
    expect(sub).toBeDefined();
    expect(sub?.supportsLimited).toBe(false);
  });

  it('seeds LOCKED for new free-tier subscriptions', () => {
    const access = buildModuleAccess('free');
    const attendance = access.find((m) => m.module === AppModule.ATTENDANCE);
    const sub = attendance?.subFeatures.find((s) => s.key === 'defaulter_alerts');
    expect(sub?.access).toBe(FeatureAccessLevel.LOCKED);
  });

  it('seeds FULL for new paid-tier subscriptions', () => {
    for (const tier of ['starter', 'pro', 'growth', 'business', 'enterprise', 'custom']) {
      const access = buildModuleAccess(tier);
      const attendance = access.find((m) => m.module === AppModule.ATTENDANCE);
      const sub = attendance?.subFeatures.find((s) => s.key === 'defaulter_alerts');
      expect(sub?.access, `tier=${tier}`).toBe(FeatureAccessLevel.FULL);
    }
  });
});
