import { describe, it, expect } from 'vitest';
import { MODULE_FEATURES_REGISTRY, buildModuleAccess } from '../module-features.registry';
import { AppModule } from '../../enums/modules.enum';

/**
 * Gating bug (2026-07-02): the sidebar "Bulk Production Entry" crown gates on
 * machines/machines_production, but that sub-feature key was MISSING from this
 * catalog, so the admin custom-plan DTO validator (validateModuleAccess) had no
 * key to accept and the web admin editor rendered no toggle. This test locks the
 * key's presence in the MACHINES module definition and asserts buildModuleAccess
 * still emits MACHINES without auto-granting it (the boot migration seeds it as
 * subFeatures: [] -> grandfather FULL), i.e. the fix does NOT change tier-default
 * gating for the existing three machines sub-features. Keep in sync with the web
 * registry (web/lib/constants/feature-access.registry.ts).
 */

const machinesDef = MODULE_FEATURES_REGISTRY.find((m) => m.module === AppModule.MACHINES);

describe('MACHINES module feature catalog', () => {
  if (!machinesDef) {
    it('has a MACHINES module definition', () => {
      expect(machinesDef).toBeDefined();
    });
    return;
  }
  const keys = machinesDef.subFeatures.map((sf) => sf.key);

  it('includes the machines_production sub-feature key', () => {
    expect(keys).toContain('machines_production');
  });

  it('keeps the existing three machines sub-features intact and unbroken', () => {
    expect(keys).toContain('machines_basic');
    expect(keys).toContain('machines_assignments');
    expect(keys).toContain('production_utilisation_dashboard');
  });

  it('machines_production mirrors the production_utilisation_dashboard shape (supportsLimited false)', () => {
    const prod = machinesDef.subFeatures.find((sf) => sf.key === 'machines_production');
    const dash = machinesDef.subFeatures.find(
      (sf) => sf.key === 'production_utilisation_dashboard',
    );
    expect(prod).toBeDefined();
    expect(dash).toBeDefined();
    expect(prod?.supportsLimited).toBe(dash?.supportsLimited);
    expect(prod?.supportsLimited).toBe(false);
    expect(typeof prod?.label).toBe('string');
    expect((prod?.label ?? '').length).toBeGreaterThan(0);
  });

  it('buildModuleAccess does NOT auto-grant machines_production on any tier (MACHINES omitted from tier defaults)', () => {
    // MACHINES is intentionally omitted from buildModuleAccess moduleList (added
    // by the boot migration with subFeatures: []), so no tier default should
    // silently grant the premium production sub-feature.
    for (const tier of ['free', 'starter', 'growth', 'business', 'custom']) {
      const machines = buildModuleAccess(tier).find((m) => m.module === AppModule.MACHINES);
      const granted = machines?.subFeatures.find((sf) => sf.key === 'machines_production');
      expect(granted).toBeUndefined();
    }
  });

  // Sibling sub-features with the same registry gap: maintenance/due 403'd on
  // machines_maintenance and downtime CRUD on machines_downtime because neither
  // key existed here (so validateModuleAccess rejected the admin payload and the
  // editor rendered no toggle). Keep in sync with the web registry + the
  // maintenance/downtime controllers' @RequireSubscription gates.
  it.each(['machines_maintenance', 'machines_downtime'])(
    'includes the %s sub-feature key',
    (key) => {
      expect(keys).toContain(key);
    },
  );

  it.each(['machines_maintenance', 'machines_downtime'])(
    '%s mirrors the sibling shape (supportsLimited false, non-empty label)',
    (key) => {
      const sf = machinesDef.subFeatures.find((s) => s.key === key);
      expect(sf).toBeDefined();
      expect(sf?.supportsLimited).toBe(false);
      expect(typeof sf?.label).toBe('string');
      expect((sf?.label ?? '').length).toBeGreaterThan(0);
    },
  );

  it.each(['machines_maintenance', 'machines_downtime'])(
    'buildModuleAccess does NOT auto-grant %s on any tier',
    (key) => {
      for (const tier of ['free', 'starter', 'growth', 'business', 'custom']) {
        const machines = buildModuleAccess(tier).find((m) => m.module === AppModule.MACHINES);
        const granted = machines?.subFeatures.find((sf) => sf.key === key);
        expect(granted).toBeUndefined();
      }
    },
  );
});
