/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so transitive
// decorated schema imports do not trip vitest's reflect-metadata pipeline.
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
// @nestjs/schedule's @Cron decorator is applied at class-eval time on the service.
vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { SubscriptionsService } from '../subscriptions.service';
import { buildModuleAccess } from '../../../common/constants/module-features.registry';

/**
 * Admin-configurable Trial Plan.
 *
 * A plan flagged `isTrialPlan` defines the entitlements a new signup's trial
 * runs on (configurable, replacing the hardcoded full-access fallback) and the
 * trial length via its own `trialDurationDays`. New signups start on the trial
 * plan; on expiry they downgrade to the DEFAULT (Free) plan via the existing,
 * unchanged downgrade machinery (purchasedEntitlements = default plan).
 *
 * When NO trial plan is configured, behavior MUST stay byte-identical to today
 * (default plan's trialDurationDays + buildTrialEntitlements fallback).
 */

const NOW = new Date('2026-06-24T00:00:00.000Z');

// Valid 24-char hex user ids — createFreeSubscription wraps userId in
// `new Types.ObjectId(...)`, which rejects non-hex strings.
const USER_1 = '0123456789abcdef01234567';
const USER_2 = '0123456789abcdef01234568';

// The DEFAULT (Free) plan's REAL entitlements — what a trial downgrades to.
const FREE_ENTITLEMENTS = {
  maxWorkspaces: 1,
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  modules: ['team', 'attendance', 'salary'],
  features: { export: false },
  moduleAccess: buildModuleAccess('free'),
};

// The configured TRIAL plan's entitlements — what the trial actually unlocks
// (admin-authored; deliberately narrower than the old hardcoded business-tier
// full access, so the test proves the configured value wins).
const TRIAL_PLAN_ENTITLEMENTS = {
  maxWorkspaces: 3,
  maxMembersPerWorkspace: 25,
  maxTotalMembers: 25,
  modules: ['team', 'attendance', 'salary', 'shifts'],
  features: { export: true },
  moduleAccess: buildModuleAccess('growth'),
};

const buildSvc = (deps: { planModel?: any; subscriptionModel?: any; appSettingsModel?: any }) =>
  new SubscriptionsService(
    deps.planModel ?? ({} as any), // planModel
    deps.subscriptionModel ?? ({} as any), // subscriptionModel
    deps.appSettingsModel ?? ({} as any), // appSettingsModel
    {} as any, // tierModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // addOnsService
    {} as any, // singleFlight
    {} as any, // userModel
    {} as any, // marketing
  );

const appSettings = (overrides: Record<string, unknown> = {}) => ({
  findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ ...overrides }) })),
});

/**
 * planModel mock that distinguishes the trial-plan lookup from the
 * default-plan lookup by the query passed to findOne, and resolves
 * findById by id from a small registry. Mirrors the real DB contract:
 *   - findOne({ isTrialPlan:true, isActive:true, product }) -> trial plan
 *   - findOne({ isDefault:true, isActive:true, product })   -> default plan
 *   - findOne({ tier:FREE, ... })                           -> free fallback
 */
const makePlanModel = (opts: {
  trialPlan?: any;
  defaultPlan?: any;
  byId?: Record<string, any>;
}) => {
  const byId = opts.byId ?? {};
  return {
    findOne: vi.fn((filter: any) => {
      let doc: any = null;
      if (filter?.isTrialPlan === true) doc = opts.trialPlan ?? null;
      else if (filter?.isDefault === true) doc = opts.defaultPlan ?? null;
      else if (filter?.tier !== undefined) doc = opts.defaultPlan ?? null; // free fallback
      return { exec: vi.fn().mockResolvedValue(doc) };
    }),
    findById: vi.fn((id: any) => ({ exec: vi.fn().mockResolvedValue(byId[id] ?? null) })),
  };
};

describe('SubscriptionsService.getTrialPlanId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the active trial plan id when one is configured', async () => {
    const planModel = makePlanModel({ trialPlan: { _id: 'trial-plan' } });
    const svc = buildSvc({ planModel });
    const id = await svc.getTrialPlanId('erp');
    expect(id).toBe('trial-plan');
    const [filter] = planModel.findOne.mock.calls[0];
    expect(filter).toEqual({ isTrialPlan: true, isActive: true, product: 'erp' });
  });

  it('returns null when no trial plan is configured', async () => {
    const planModel = makePlanModel({ trialPlan: null });
    const svc = buildSvc({ planModel });
    expect(await svc.getTrialPlanId('erp')).toBeNull();
  });
});

describe('SubscriptionsService.startTrial — WITH a configured trial plan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts the trial on the TRIAL plan entitlements + length, downgrade target = DEFAULT plan', async () => {
    const trialPlan = {
      _id: 'trial-plan',
      product: 'erp',
      trialDurationDays: 30,
      entitlements: TRIAL_PLAN_ENTITLEMENTS,
    };
    const defaultPlan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 14, // deliberately different — must be IGNORED in favor of the trial plan's
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': trialPlan, 'default-plan': defaultPlan },
    });
    const subscriptionModel = {
      // Eligibility (ever-trialed) lookup returns null = eligible.
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
      // supersedeCurrent internals.
      updateMany: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) })),
      findOneAndUpdate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'sub-trial', ...doc });
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const sub: any = await svc.startTrial(USER_1, 'erp', NOW);

    const doc = created[0];
    expect(doc.status).toBe('trial');

    // Length comes from the TRIAL plan (30), not the default plan (14).
    const expectedEnd = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(new Date(doc.trialEndsAt).getTime()).toBe(expectedEnd.getTime());
    expect(new Date(doc.currentPeriodEnd).getTime()).toBe(expectedEnd.getTime());

    // appliedEntitlements = the CONFIGURED trial plan entitlements (NOT the
    // hardcoded business-tier buildTrialEntitlements fallback).
    expect(doc.appliedEntitlements).toEqual(TRIAL_PLAN_ENTITLEMENTS);
    expect(doc.appliedEntitlements.maxTotalMembers).toBe(25);

    // purchasedEntitlements = the DEFAULT plan entitlements (downgrade target).
    expect(doc.purchasedEntitlements).toEqual(FREE_ENTITLEMENTS);

    // planId points at the DEFAULT plan (where the sub lands post-downgrade).
    expect(doc.planId).toBe('default-plan');

    expect(sub._id).toBe('sub-trial');
  });
});

describe('SubscriptionsService.createFreeSubscription — opt-in: no auto-trial', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lands on the ACTIVE default plan even when a trial plan is configured', async () => {
    const trialPlan = {
      _id: 'trial-plan',
      product: 'erp',
      trialDurationDays: 30,
      entitlements: TRIAL_PLAN_ENTITLEMENTS,
    };
    const defaultPlan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 14,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': trialPlan, 'default-plan': defaultPlan },
    });
    const subscriptionModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'sub-active', ...doc });
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    await svc.createFreeSubscription(USER_2, 'self', NOW);

    const doc = created[0];
    // ACTIVE on the DEFAULT plan — auto-start is off under the opt-in model.
    expect(doc.status).toBe('active');
    expect(doc.trialEndsAt).toBeUndefined();
    expect(doc.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.purchasedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.planId).toBe('default-plan');
  });
});

describe('SubscriptionsService.downgradeToBasePlan — after a trial-plan trial', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops to the DEFAULT plan entitlements (applied = purchased) via the existing method', async () => {
    const updates: any[] = [];
    const subscriptionModel = {
      updateOne: vi.fn((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
      }),
    };
    const svc = buildSvc({ subscriptionModel });

    // A trial sub created by the trial-plan path: applied = trial entitlements,
    // purchased = DEFAULT plan entitlements (the downgrade target).
    const sub: any = {
      _id: 'sub-trial',
      status: 'trial',
      trialEndsAt: new Date(NOW.getTime() - 1000),
      purchasedEntitlements: FREE_ENTITLEMENTS,
      appliedEntitlements: TRIAL_PLAN_ENTITLEMENTS,
    };

    const changed = await (svc as any).downgradeToBasePlan(sub, NOW);
    expect(changed).toBe(true);

    const set = updates[0].update.$set;
    expect(set.status).toBe('active');
    // Lands on the DEFAULT plan entitlements (applied now === purchased).
    expect(set.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
  });
});

describe('SubscriptionsService.getPublicTrialBannerConfig — trial-plan aware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads days from the TRIAL plan when one is configured', async () => {
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: {
        'trial-plan': { trialDurationDays: 30 },
        'default-plan': { trialDurationDays: 14 },
      },
    });
    const svc = buildSvc({
      planModel,
      appSettingsModel: appSettings({
        trialBanner: { enabled: true, headlineOverride: '' },
      }) as any,
    });

    const cfg = await svc.getPublicTrialBannerConfig();
    expect(cfg.days).toBe(30); // trial plan wins
  });

  it('falls back to the DEFAULT plan days when no trial plan is configured', async () => {
    const planModel = makePlanModel({
      trialPlan: null,
      defaultPlan: { _id: 'default-plan' },
      byId: { 'default-plan': { trialDurationDays: 14 } },
    });
    const svc = buildSvc({
      planModel,
      appSettingsModel: appSettings({
        trialBanner: { enabled: true, headlineOverride: '' },
      }) as any,
    });

    const cfg = await svc.getPublicTrialBannerConfig();
    expect(cfg.days).toBe(14); // default plan fallback (unchanged)
  });
});
