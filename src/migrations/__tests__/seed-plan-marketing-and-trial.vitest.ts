/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migration 0060 — plan marketing backfill + 45-day trial plan seed.
 *
 * Asserts:
 *   (a) each ERP plan gets marketing.tagline + featureHighlights (all 4 locale
 *       keys) + isHighlighted (true only on growth) + displayOrder;
 *   (b) the trial plan is created with isTrialPlan / trialDurationDays 45 /
 *       isPubliclyVisible false / full moduleAccess incl machines sub-features FULL;
 *   (c) re-run is idempotent — the trial plan is NOT duplicated when one exists.
 *
 * Uses the @nestjs/mongoose decorator-mock pattern so the transitively-decorated
 * Plan schema import does not trip vitest's reflect-metadata pipeline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { SeedPlanMarketingAndTrialService } from '../seed-plan-marketing-and-trial.service';
import { AppModule } from '../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../common/enums/feature-access.enum';

const LOCALES = ['en', 'gu', 'gu-en', 'hi-en'] as const;
const TIERS = ['free', 'starter', 'growth', 'business'] as const;

// Valid 24-char hex ObjectIds for the 4 canonical ERP plans (findOne returns
// these so updateOne targets a real _id).
const PLAN_ID: Record<string, string> = {
  free: '0123456789abcdef00000001',
  starter: '0123456789abcdef00000002',
  growth: '0123456789abcdef00000003',
  business: '0123456789abcdef00000004',
};

/**
 * planModel mock: findOne resolves the ERP plan by tier (for marketing) OR the
 * trial plan by isTrialPlan (for the trial seed). updateOne + create record
 * their calls so the assertions can inspect the written docs.
 */
function makePlanModel(opts: { existingTrial?: any; missingTiers?: string[] } = {}) {
  const missing = new Set(opts.missingTiers ?? []);
  const updateCalls: Array<{ filter: any; update: any }> = [];
  const createCalls: any[] = [];

  const model: any = {
    findOne: vi.fn((filter: any) => {
      // Trial-plan lookup ({ isTrialPlan:true, product:'erp' }).
      if (filter?.isTrialPlan === true) {
        return { exec: vi.fn().mockResolvedValue(opts.existingTrial ?? null) };
      }
      // ERP plan-by-tier lookup ({ tier, product: { $ne:'connect' } }).
      const tier = filter?.tier;
      if (tier && !missing.has(tier)) {
        return {
          exec: vi.fn().mockResolvedValue({ _id: PLAN_ID[tier], name: tier, tier }),
        };
      }
      return { exec: vi.fn().mockResolvedValue(null) };
    }),
    updateOne: vi.fn((filter: any, update: any) => {
      updateCalls.push({ filter, update });
      return { exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
    }),
    create: vi.fn((doc: any) => {
      createCalls.push(doc);
      return Promise.resolve({ _id: 'trial-plan', ...doc });
    }),
  };
  return { model, updateCalls, createCalls };
}

function makeSvc(planModel: any): SeedPlanMarketingAndTrialService {
  return new SeedPlanMarketingAndTrialService(planModel);
}

describe('0060 marketing backfill', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets marketing on every ERP plan with all 4 locale keys on tagline + each highlight', async () => {
    const { model, updateCalls } = makePlanModel();
    const svc = makeSvc(model);

    const res = await svc.backfillMarketing();
    expect(res.updated).toBe(4);
    expect(res.missing).toBe(0);
    expect(updateCalls.length).toBe(4);

    // Index the writes by the plan _id they targeted.
    const setByTier: Record<string, any> = {};
    for (const call of updateCalls) {
      const id = call.filter._id;
      const tier = TIERS.find((t) => PLAN_ID[t] === id);
      if (tier) setByTier[tier] = call.update.$set;
    }

    for (const tier of TIERS) {
      const set = setByTier[tier];
      expect(set, `missing $set for ${tier}`).toBeTruthy();

      // tagline: all 4 locales present + non-empty.
      for (const loc of LOCALES) {
        expect(set['marketing.tagline'][loc], `${tier} tagline.${loc}`).toBeTruthy();
      }

      // featureHighlights: array of localized bullets, each with all 4 locales.
      const highlights = set['marketing.featureHighlights'];
      expect(Array.isArray(highlights)).toBe(true);
      expect(highlights.length).toBeGreaterThan(0);
      for (const h of highlights) {
        for (const loc of LOCALES) {
          expect(h[loc], `${tier} highlight.${loc}`).toBeTruthy();
        }
      }

      expect(typeof set['marketing.displayOrder']).toBe('number');
      expect(typeof set['marketing.isHighlighted']).toBe('boolean');
    }

    // displayOrder free=0 / starter=1 / growth=2 / business=3.
    expect(setByTier.free['marketing.displayOrder']).toBe(0);
    expect(setByTier.starter['marketing.displayOrder']).toBe(1);
    expect(setByTier.growth['marketing.displayOrder']).toBe(2);
    expect(setByTier.business['marketing.displayOrder']).toBe(3);

    // Only Growth is highlighted.
    expect(setByTier.growth['marketing.isHighlighted']).toBe(true);
    expect(setByTier.free['marketing.isHighlighted']).toBe(false);
    expect(setByTier.starter['marketing.isHighlighted']).toBe(false);
    expect(setByTier.business['marketing.isHighlighted']).toBe(false);
  });

  it('carries NO GST wording in any locale (GST module launches later)', async () => {
    const { model, updateCalls } = makePlanModel();
    const svc = makeSvc(model);
    await svc.backfillMarketing();

    const banned = /\bGST\b|GSTIN|GSTR|e-Invoice|e-Way/i;
    for (const call of updateCalls) {
      const set = call.update.$set;
      const strings: string[] = [
        ...Object.values(set['marketing.tagline']),
        ...set['marketing.featureHighlights'].flatMap((h: any) => Object.values(h)),
      ] as string[];
      for (const s of strings) {
        expect(banned.test(s), `banned GST wording in: ${s}`).toBe(false);
      }
    }
  });

  it('warns + skips a tier whose ERP plan is missing (does not create it)', async () => {
    const { model, updateCalls } = makePlanModel({ missingTiers: ['business'] });
    const svc = makeSvc(model);

    const res = await svc.backfillMarketing();
    expect(res.updated).toBe(3);
    expect(res.missing).toBe(1);
    expect(updateCalls.length).toBe(3);
  });
});

describe('0060 trial-plan seed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the 45-day full-access trial plan when none exists', async () => {
    const { model, createCalls } = makePlanModel({ existingTrial: null });
    const svc = makeSvc(model);

    const res = await svc.seedTrialPlan();
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(createCalls.length).toBe(1);

    const doc = createCalls[0];
    expect(doc.name).toBe('45-Day Free Trial');
    expect(doc.product).toBe('erp');
    expect(doc.isTrialPlan).toBe(true);
    expect(doc.trialDurationDays).toBe(45);
    expect(doc.isPubliclyVisible).toBe(false);
    expect(doc.isDefault).toBe(false);
    expect(doc.monthlyPrice).toBe(0);
    expect(doc.yearlyPrice).toBe(0);

    // Localized trial tagline in all 4 locales.
    for (const loc of LOCALES) {
      expect(doc.marketing.tagline[loc], `trial tagline.${loc}`).toBeTruthy();
    }

    // Full access: unlimited caps.
    expect(doc.entitlements.maxTotalMembers).toBe(-1);
    expect(doc.entitlements.maxMembersPerWorkspace).toBe(-1);

    const moduleAccess: any[] = doc.entitlements.moduleAccess;
    const byModule = new Map(moduleAccess.map((m) => [m.module, m]));

    // The omitted modules are present + enabled with all sub-features FULL.
    for (const mod of [AppModule.MACHINES, AppModule.LOCATIONS, AppModule.RESOURCE_SCOPES]) {
      const entry = byModule.get(mod);
      expect(entry, `missing ${mod}`).toBeTruthy();
      expect(entry.enabled).toBe(true);
      expect(entry.subFeatures.length).toBeGreaterThan(0);
      for (const sf of entry.subFeatures) {
        expect(sf.access).toBe(FeatureAccessLevel.FULL);
      }
    }

    // The four machines power sub-features are unlocked at FULL.
    const machines = byModule.get(AppModule.MACHINES);
    const machinesKeys = new Set(machines.subFeatures.map((sf: any) => sf.key));
    for (const key of [
      'machines_production',
      'machines_maintenance',
      'machines_downtime',
      'piece_rate_payroll',
    ]) {
      expect(machinesKeys.has(key), `machines missing ${key}`).toBe(true);
    }
  });

  it('is idempotent — skips (does not duplicate) when a trial plan already exists', async () => {
    const { model, createCalls } = makePlanModel({
      existingTrial: { _id: 'existing-trial', name: '45-Day Free Trial' },
    });
    const svc = makeSvc(model);

    const res = await svc.seedTrialPlan();
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(createCalls.length).toBe(0);
  });
});
