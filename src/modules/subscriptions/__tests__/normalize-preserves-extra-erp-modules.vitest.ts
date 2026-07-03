/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SubscriptionsService so the
// transitive decorated schema imports (Plan, Subscription, Tier, Workspace, ...)
// do not trip vitest's reflect-metadata pipeline. Mirrors connect-normalization
// .vitest.ts — normalizeEntitlementsForTier touches no model, only resolveTierKey
// (pure) + the imported buildModuleAccess (pure).
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

import { SubscriptionsService } from '../subscriptions.service';
import { buildModuleAccess } from '../../../common/constants/module-features.registry';
import type { PlanEntitlements } from '../schemas/plan.schema';

/**
 * Access-control regression lock: admin-enabled MACHINES / LOCATIONS /
 * RESOURCE_SCOPES must survive ERP normalization.
 *
 * `buildModuleAccess(tier)` INTENTIONALLY omits MACHINES / LOCATIONS /
 * RESOURCE_SCOPES from its tier template (they are added by dedicated boot
 * migration services — see module-features.registry.ts). Before the fix,
 * normalizeEntitlementsForTier rebuilt moduleAccess by mapping only over the
 * template, so an admin-enabled Machines module present in the plan/DTO
 * moduleAccess was silently STRIPPED on assign and re-stripped on every
 * getMySubscription read (which persists the stripped value) — user saw
 * Machines LOCKED.
 *
 * The fix re-appends every currentAccess entry whose module is a KNOWN ERP
 * registry module but absent from the template (mirror of the existing
 * extraSubFeatures logic, at the module level). Foreign non-ERP modules
 * (e.g. Connect on an ERP sub) are still dropped — see
 * connect-normalization.vitest.ts.
 */
describe('SubscriptionsService.normalizeEntitlementsForTier — preserves admin-enabled extra ERP modules', () => {
  let svc: SubscriptionsService;

  beforeEach(() => {
    const model = () => ({}) as any;
    svc = new SubscriptionsService(
      model(), // planModel
      model(), // subscriptionModel
      model(), // appSettingsModel
      model(), // tierModel
      model(), // workspaceModel
      {} as any, // addOnsService
    );
  });

  // A business-tier ERP subscription whose admin has enabled the Machines
  // module (omitted from buildModuleAccess's template). Start from the tier
  // template so the normal modules are already correct, then splice in machines.
  const buildErpEntitlementsWithMachines = (): PlanEntitlements => {
    const template = buildModuleAccess('business');
    return {
      modules: [...template.filter((m) => m.enabled).map((m) => m.module), 'machines'],
      moduleAccess: [
        ...template,
        {
          module: 'machines',
          enabled: true,
          subFeatures: [
            { key: 'machines_basic', access: 'full' },
            { key: 'machines_assignments', access: 'full' },
          ],
        },
      ],
    } as unknown as PlanEntitlements;
  };

  it('KEEPS an admin-enabled machines module (template omits it) with its subFeatures preserved', () => {
    const input = buildErpEntitlementsWithMachines();
    const result = svc.normalizeEntitlementsForTier(input, 'business', 'erp');

    const machinesModule = (result.entitlements.moduleAccess as any[]).find(
      (m) => m.module === 'machines',
    );
    expect(machinesModule).toBeDefined();
    expect(machinesModule.enabled).toBe(true);
    expect(machinesModule.subFeatures.map((s: any) => s.key)).toEqual([
      'machines_basic',
      'machines_assignments',
    ]);

    // machines is enabled so it lands in the normalized `modules` list.
    expect(result.entitlements.modules).toContain('machines');
  });

  it('also preserves locations + resource_scopes when admin-enabled', () => {
    const template = buildModuleAccess('business');
    const input = {
      moduleAccess: [
        ...template,
        {
          module: 'locations',
          enabled: true,
          subFeatures: [{ key: 'location_manage', access: 'full' }],
        },
        {
          module: 'resource_scopes',
          enabled: true,
          subFeatures: [{ key: 'resource_scope_manage', access: 'full' }],
        },
      ],
    } as unknown as PlanEntitlements;

    const result = svc.normalizeEntitlementsForTier(input, 'business', 'erp');
    const modules = (result.entitlements.moduleAccess as any[]).map((m) => m.module);
    expect(modules).toContain('locations');
    expect(modules).toContain('resource_scopes');
  });

  it('orders template modules first, then the preserved extras (deterministic)', () => {
    const input = buildErpEntitlementsWithMachines();
    const result = svc.normalizeEntitlementsForTier(input, 'business', 'erp');
    const modules = (result.entitlements.moduleAccess as any[]).map((m) => m.module);

    const templateModules = buildModuleAccess('business').map((m) => m.module);
    // First N entries equal the template, in order.
    expect(modules.slice(0, templateModules.length)).toEqual(templateModules);
    // machines (the extra) comes after the template block.
    expect(modules.indexOf('machines')).toBeGreaterThanOrEqual(templateModules.length);
  });

  it('no regression: normal template modules + sub-features still normalize correctly', () => {
    // A minimal ERP sub — attendance present with one preserved custom sub-feature
    // plus a template-covered sub-feature, and a template module absent from input
    // that must be filled from the template.
    const input = {
      moduleAccess: [
        {
          module: 'attendance',
          enabled: true,
          subFeatures: [{ key: 'zzz_admin_extra', access: 'full' }],
        },
      ],
    } as unknown as PlanEntitlements;

    const result = svc.normalizeEntitlementsForTier(input, 'business', 'erp');
    const access = result.entitlements.moduleAccess as any[];

    // A genuinely-absent template module (team) is filled from the template.
    const teamModule = access.find((m) => m.module === 'team');
    expect(teamModule).toBeDefined();

    // attendance keeps its admin-added extra sub-feature (extraSubFeatures path).
    const attendance = access.find((m) => m.module === 'attendance');
    expect(attendance.subFeatures.some((s: any) => s.key === 'zzz_admin_extra')).toBe(true);

    // No machines entry appears — input never had it, template omits it.
    expect(access.find((m) => m.module === 'machines')).toBeUndefined();
  });
});
