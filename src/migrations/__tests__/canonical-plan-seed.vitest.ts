/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase-1 ERP pricing rework — canonical seed contract.
 *
 * Asserts the canonical ERP tier/plan set seeded by
 * `seed-default-tiers-and-plans.ts` is EXACTLY the 5 owner-confirmed plans:
 *   free / starter / growth / business / custom
 * with Enterprise RETIRED (no longer a seedable/public plan) and Custom seeded
 * NOT-publicly-visible + flagged custom.
 *
 * Keep-in-sync: if the canonical plan set changes, update both this test and the
 * retire-legacy-erp-plans migration (which deactivates anything outside this set).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { SeedDefaultTiersAndPlansService } from '../seed-default-tiers-and-plans';
import {
  CANONICAL_ERP_TIER_CAPS,
  CANONICAL_ERP_PLAN_PRICES,
} from '../canonical-erp-plans.constants';

/** Reach the private definition arrays for structural assertions. */
function tierDefs(svc: SeedDefaultTiersAndPlansService): any[] {
  return (svc as any).TIER_DEFINITIONS;
}
function planDefs(svc: SeedDefaultTiersAndPlansService): any[] {
  return (svc as any).PLAN_DEFINITIONS;
}

function makeSvc(tierModel: any = {}, planModel: any = {}): SeedDefaultTiersAndPlansService {
  return new SeedDefaultTiersAndPlansService(tierModel, planModel);
}

describe('Canonical ERP tier/plan seed (Phase 1 pricing)', () => {
  it('seeds exactly the 5 canonical tiers and NOT enterprise', () => {
    const svc = makeSvc();
    const tierKeys = tierDefs(svc).map((t) => t.key);
    expect(new Set(tierKeys)).toEqual(new Set(['free', 'starter', 'growth', 'business', 'custom']));
    expect(tierKeys).not.toContain('enterprise');
    expect(tierKeys.length).toBe(5);
  });

  it('seeds exactly the 5 canonical plans and NOT an enterprise plan', () => {
    const svc = makeSvc();
    const planTiers = planDefs(svc).map((p) => p.tier);
    expect(new Set(planTiers)).toEqual(
      new Set(['free', 'starter', 'growth', 'business', 'custom']),
    );
    expect(planTiers).not.toContain('enterprise');
    expect(planTiers.length).toBe(5);
  });

  // Fresh installs now seed the clean admin-panel names ("Free"/"Starter"/
  // "Growth"/"Business"/"Custom"), NOT the old "... Monthly" / "... Plan"
  // labels. The owner renames existing rows manually in admin; this only
  // governs what a brand-new DB gets seeded with.
  it('seeds the clean plan names per tier (no "... Monthly" / "... Plan")', () => {
    const svc = makeSvc();
    const nameByTier: Record<string, string> = {};
    for (const p of planDefs(svc)) nameByTier[p.tier] = p.name;
    expect(nameByTier.free).toBe('Free');
    expect(nameByTier.starter).toBe('Starter');
    expect(nameByTier.growth).toBe('Growth');
    expect(nameByTier.business).toBe('Business');
    expect(nameByTier.custom).toBe('Custom');
    // None of the old verbose labels survive.
    const allNames = Object.values(nameByTier);
    for (const n of allNames) {
      expect(n).not.toMatch(/Monthly|Plan/);
    }
  });

  // Pin the absolute owner-confirmed numbers AT THE CONSTANTS layer (so a stray
  // edit to the shared module is caught), then prove the seed wires each tier's
  // caps/prices from those same constants (so seed + reconcile can't drift).
  it('the shared constants hold the owner-confirmed staff caps (maxMembersPerWorkspace)', () => {
    expect(CANONICAL_ERP_TIER_CAPS.free.maxMembersPerWorkspace).toBe(5);
    expect(CANONICAL_ERP_TIER_CAPS.starter.maxMembersPerWorkspace).toBe(25);
    expect(CANONICAL_ERP_TIER_CAPS.growth.maxMembersPerWorkspace).toBe(100);
    expect(CANONICAL_ERP_TIER_CAPS.business.maxMembersPerWorkspace).toBe(500);
    expect(CANONICAL_ERP_TIER_CAPS.custom.maxMembersPerWorkspace).toBe(-1); // unlimited
  });

  it('the seed wires each tier defaultEntitlements from the shared caps constant', () => {
    const svc = makeSvc();
    const capByTier: Record<string, any> = {};
    for (const t of tierDefs(svc)) capByTier[t.key] = t.defaultEntitlements;
    expect(capByTier.free).toEqual(CANONICAL_ERP_TIER_CAPS.free);
    expect(capByTier.starter).toEqual(CANONICAL_ERP_TIER_CAPS.starter);
    expect(capByTier.growth).toEqual(CANONICAL_ERP_TIER_CAPS.growth);
    expect(capByTier.business).toEqual(CANONICAL_ERP_TIER_CAPS.business);
    expect(capByTier.custom).toEqual(CANONICAL_ERP_TIER_CAPS.custom);
  });

  it('the shared constants hold the owner-confirmed prices', () => {
    expect(CANONICAL_ERP_PLAN_PRICES.free).toEqual({ monthlyPrice: 0, yearlyPrice: 0 });
    expect(CANONICAL_ERP_PLAN_PRICES.starter).toEqual({ monthlyPrice: 999, yearlyPrice: 9999 });
    expect(CANONICAL_ERP_PLAN_PRICES.growth).toEqual({ monthlyPrice: 2499, yearlyPrice: 24999 });
    expect(CANONICAL_ERP_PLAN_PRICES.business).toEqual({ monthlyPrice: 4999, yearlyPrice: 49999 });
    expect(CANONICAL_ERP_PLAN_PRICES.custom).toEqual({ monthlyPrice: 0, yearlyPrice: 0 });
  });

  it('the seed wires each plan price from the shared prices constant', () => {
    const svc = makeSvc();
    const byTier: Record<string, any> = {};
    for (const p of planDefs(svc)) byTier[p.tier] = p;
    for (const tier of ['free', 'starter', 'growth', 'business', 'custom'] as const) {
      expect(byTier[tier].monthlyPrice).toBe(CANONICAL_ERP_PLAN_PRICES[tier].monthlyPrice);
      expect(byTier[tier].yearlyPrice).toBe(CANONICAL_ERP_PLAN_PRICES[tier].yearlyPrice);
    }
  });

  it('seedPlans: Custom plan inserts with isPubliclyVisible:false + isCustom:true; the 4 self-serve plans stay public', async () => {
    // Stub a tier row for every plan lookup; planModel.findOne -> null so every
    // plan inserts; capture create payloads.
    const tierRow = {
      defaultEntitlements: {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
      },
    };
    const created: any[] = [];
    const tierModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(tierRow) }),
    };
    const planModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      create: vi.fn().mockImplementation((doc: any) => {
        created.push(doc);
        return Promise.resolve(doc);
      }),
    };
    const svc = makeSvc(tierModel, planModel);

    const res = await svc.seedPlans();

    expect(res.inserted).toBe(5);
    expect(created.length).toBe(5);

    const byTier: Record<string, any> = {};
    for (const doc of created) byTier[doc.tier] = doc;

    // Custom: hidden + flagged custom.
    expect(byTier.custom).toBeDefined();
    expect(byTier.custom.isPubliclyVisible).toBe(false);
    expect(byTier.custom.isCustom).toBe(true);

    // The 4 self-serve plans are publicly visible and NOT custom.
    for (const tier of ['free', 'starter', 'growth', 'business']) {
      expect(byTier[tier]).toBeDefined();
      // isPubliclyVisible may be omitted (schema default true) or set true,
      // but must never be false; isCustom must never be true.
      expect(byTier[tier].isPubliclyVisible).not.toBe(false);
      expect(byTier[tier].isCustom).not.toBe(true);
    }

    // No enterprise plan is ever created.
    expect(byTier.enterprise).toBeUndefined();
  });

  it('seedPlans: ONLY the Free plan seeds as the default (isDefault:true); others falsy (Phase 2)', async () => {
    const tierRow = {
      defaultEntitlements: {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
      },
    };
    const created: any[] = [];
    const tierModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(tierRow) }),
    };
    const planModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      create: vi.fn().mockImplementation((doc: any) => {
        created.push(doc);
        return Promise.resolve(doc);
      }),
    };
    const svc = makeSvc(tierModel, planModel);

    await svc.seedPlans();

    const byTier: Record<string, any> = {};
    for (const doc of created) byTier[doc.tier] = doc;

    // Free seeds as the default new sign-ups are auto-assigned.
    expect(byTier.free.isDefault).toBe(true);
    // Every non-free plan must NOT be the default.
    for (const tier of ['starter', 'growth', 'business', 'custom']) {
      expect(byTier[tier].isDefault).toBe(false);
    }
  });

  it('legacy features.shifts is true for ALL tiers (moduleAccess is the real source of truth)', async () => {
    const tierRow = {
      defaultEntitlements: {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
      },
    };
    const created: any[] = [];
    const tierModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(tierRow) }),
    };
    const planModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      create: vi.fn().mockImplementation((doc: any) => {
        created.push(doc);
        return Promise.resolve(doc);
      }),
    };
    const svc = makeSvc(tierModel, planModel);

    await svc.seedPlans();

    for (const doc of created) {
      expect(doc.entitlements.features.shifts).toBe(true);
    }
  });

  // ── ANTI-DUPLICATE GUARANTEE (rename-safe seeding) ──────────────────
  // seedPlans() must match an existing ERP plan by TIER (scoped to NOT-connect),
  // NOT by name. So if the owner has renamed a seeded plan in admin (e.g.
  // "Growth Monthly" -> "Growth Pro"), the next seed run still finds it by tier
  // and SKIPS it — it must never re-insert a duplicate under the old name.
  it('seedPlans: skips a tier whose ERP plan already exists UNDER A DIFFERENT NAME (no duplicate)', async () => {
    const tierRow = {
      defaultEntitlements: {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
      },
    };
    const created: any[] = [];
    // Capture the queries seedPlans uses to test for an existing plan so we can
    // assert it matches by tier + non-connect scope (NOT by name).
    const planFindOneQueries: any[] = [];
    const tierModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(tierRow) }),
    };
    const planModel = {
      findOne: vi.fn().mockImplementation((query: any) => {
        planFindOneQueries.push(query);
        // Simulate: the 'growth' tier ALREADY has an ERP plan, but it was
        // renamed in admin so its name no longer matches planDef.name. The
        // match is by tier, so it is still found and skipped. Every other tier
        // has no existing plan.
        const existing =
          query && query.tier === 'growth'
            ? { _id: 'existing-growth', name: 'Growth Pro Renamed', tier: 'growth' }
            : null;
        return { exec: vi.fn().mockResolvedValue(existing) };
      }),
      create: vi.fn().mockImplementation((doc: any) => {
        created.push(doc);
        return Promise.resolve(doc);
      }),
    };
    const svc = makeSvc(tierModel, planModel);

    const res = await svc.seedPlans();

    // Growth was found-by-tier -> skipped; the other 4 inserted.
    expect(res.skipped).toBe(1);
    expect(res.inserted).toBe(4);

    // create() was NEVER called for the growth tier (no duplicate row).
    const createdTiers = created.map((d) => d.tier);
    expect(createdTiers).not.toContain('growth');
    expect(new Set(createdTiers)).toEqual(new Set(['free', 'starter', 'business', 'custom']));

    // The existence probe matched by tier + non-connect scope, NOT by name —
    // this is what makes the owner's manual rename safe.
    const probe = planFindOneQueries.find((q) => q && q.tier === 'growth');
    expect(probe).toBeDefined();
    expect(probe.tier).toBe('growth');
    // ERP plans omit product or set 'erp'; Connect plans are product:'connect'
    // and must NOT collide — the scope excludes them.
    expect(probe.product).toEqual({ $ne: 'connect' });
    // The query must NOT key off the plan name (the whole point of the fix).
    expect('name' in probe).toBe(false);
  });
});
