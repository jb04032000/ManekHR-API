/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SubscriptionsService so the
// transitive decorated schema imports (Plan, Subscription, Tier, Workspace, ...)
// do not trip vitest's reflect-metadata pipeline. No real Mongoose is used here:
// normalizeEntitlementsForTier touches no model, only resolveTierKey (pure) and
// the imported buildModuleAccess (pure).
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
 * M0.3 / risk #2 regression lock.
 *
 * The ERP repair/normalize routines rebuild `moduleAccess` from an ERP-only
 * module registry (buildModuleAccess). Before M0.3, every getMySubscription
 * read passed a Connect subscription through this and would STRIP its CONNECT
 * module access + reset it to ERP free-tier defaults.
 *
 * M0.3 added a `product` branch: when product === 'connect' the entitlements
 * are returned unchanged. These tests prove:
 *   1. a Connect sub survives normalization untouched (allowances + module
 *      access preserved), and
 *   2. the ERP path is unchanged (still rebuilds from the ERP registry),
 * so the fix neither leaks ERP defaults onto Connect nor regresses ERP.
 *
 * If the `if (product === 'connect')` branch were removed, tests 1, 2 and 3
 * would fail (Connect module access stripped / back-filled with ERP modules).
 */
describe('SubscriptionsService.normalizeEntitlementsForTier — Connect awareness (M0.3, risk #2)', () => {
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

  // A Connect subscription carries CONNECT module access + a `connect` allowance
  // sub-block that the ERP module registry (buildModuleAccess) does NOT know.
  const buildConnectEntitlements = (): PlanEntitlements =>
    ({
      modules: ['connect'],
      moduleAccess: [
        {
          module: 'connect',
          enabled: true,
          subFeatures: [
            { key: 'marketplace.listings', access: 'full' },
            { key: 'marketplace.leads', access: 'full' },
          ],
        },
      ],
      connect: {
        maxListings: 25,
        leadsPerMonth: -1,
        includedBoostCredits: 0,
        verifiedBadge: false,
        searchPriority: 0,
      },
    }) as unknown as PlanEntitlements;

  it("returns a product:'connect' subscription's entitlements UNCHANGED (does not strip Connect module access)", () => {
    const input = buildConnectEntitlements();
    const result = svc.normalizeEntitlementsForTier(input, 'free', 'connect');

    expect(result.changed).toBe(false);
    // base returned as-is (same reference) — no ERP rebuild.
    expect(result.entitlements).toBe(input);

    // The CONNECT module access survives (ERP buildModuleAccess would have dropped it).
    const connectModule = (result.entitlements.moduleAccess as any[]).find(
      (m) => m.module === 'connect',
    );
    expect(connectModule).toBeDefined();
    expect(connectModule.subFeatures.map((s: any) => s.key)).toEqual([
      'marketplace.listings',
      'marketplace.leads',
    ]);

    // The connect allowance sub-block is preserved.
    expect((result.entitlements as any).connect).toMatchObject({
      maxListings: 25,
      leadsPerMonth: -1,
    });
  });

  it('does NOT back-fill ERP module access onto a connect sub even when moduleAccess is empty', () => {
    const input = {
      moduleAccess: [],
      connect: { maxListings: 3 },
    } as unknown as PlanEntitlements;
    const result = svc.normalizeEntitlementsForTier(input, 'free', 'connect');

    expect(result.changed).toBe(false);
    expect(result.entitlements.moduleAccess).toEqual([]); // stayed empty, not ERP-filled
    expect((result.entitlements as any).connect).toMatchObject({ maxListings: 3 });
  });

  it('ERP normalization rebuilds from the ERP registry and drops unknown Connect module access (why M0.3 must branch)', () => {
    // Same Connect-shaped entitlements, but classified as an ERP subscription.
    const input = buildConnectEntitlements();
    const result = svc.normalizeEntitlementsForTier(input, 'free', 'erp');

    // ERP path ran buildModuleAccess('free') -> registry-derived module access.
    expect(result.entitlements.moduleAccess).toEqual(buildModuleAccess('free'));
    // The 'connect' module entry is gone (the ERP registry does not include it).
    const connectModule = (result.entitlements.moduleAccess as any[]).find(
      (m) => m.module === 'connect',
    );
    expect(connectModule).toBeUndefined();
    // empty/foreign ERP module access -> normalization reports a change.
    expect(result.changed).toBe(true);
  });

  it('treats an undefined product as ERP (back-compat with pre-M0.3 callers)', () => {
    const input = { moduleAccess: [] } as unknown as PlanEntitlements;
    const resultNoProduct = svc.normalizeEntitlementsForTier(input, 'free');

    // No early-return: ERP registry defaults are applied, identical to product='erp'.
    expect(resultNoProduct.entitlements.moduleAccess).toEqual(buildModuleAccess('free'));
    expect(resultNoProduct.changed).toBe(true);
  });
});
