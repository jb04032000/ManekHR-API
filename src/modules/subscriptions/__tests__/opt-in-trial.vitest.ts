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
 * Opt-in trial model (owner directive, 2026-06-24).
 *
 * The trial is no longer auto-started at signup. New users land on the DEFAULT
 * (Free) plan as status:'active'. They start the trial EXPLICITLY via
 * startTrial(), which is one-time per user forever. While in trial they get the
 * trial plan's entitlements + a countdown; buying a paid plan during the trial
 * supersedes it; on expiry it downgrades to Free (existing machinery).
 */

const NOW = new Date('2026-06-24T00:00:00.000Z');

// Valid 24-char hex user ids — createFreeSubscription / startTrial wrap userId
// in `new Types.ObjectId(...)`, which rejects non-hex strings.
const USER_1 = '0123456789abcdef01234567';

const FREE_ENTITLEMENTS = {
  maxWorkspaces: 1,
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  modules: ['team', 'attendance', 'salary'],
  features: { export: false },
  moduleAccess: buildModuleAccess('free'),
};

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

describe('createFreeSubscription — opt-in model: NEVER auto-starts a trial', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an ACTIVE default sub even when a trial plan IS configured (no auto-trial)', async () => {
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

    await svc.createFreeSubscription(USER_1, 'self', NOW);

    const doc = created[0];
    // ACTIVE on the DEFAULT plan — NOT a trial, despite a configured trial plan.
    expect(doc.status).toBe('active');
    expect(doc.trialEndsAt).toBeUndefined();
    expect(doc.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.purchasedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.planId).toBe('default-plan');
    // Never expires on its own.
    expect(new Date(doc.currentPeriodEnd).getFullYear()).toBeGreaterThan(NOW.getFullYear() + 50);
  });
});

describe('startTrial — eligibility + one-time enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  const buildEligible = (overrides: { existing?: any } = {}) => {
    const trialPlan = {
      _id: 'trial-plan',
      product: 'erp',
      trialDurationDays: 30,
      entitlements: TRIAL_PLAN_ENTITLEMENTS,
    };
    const defaultPlan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 0,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': trialPlan, 'default-plan': defaultPlan },
    });
    const subscriptionModel = {
      // The eligibility (ever-trialed) lookup.
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(overrides.existing ?? null) })),
      // supersedeCurrent uses updateMany + findOneAndUpdate.
      updateMany: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) })),
      findOneAndUpdate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'sub-trial', ...doc });
      }),
    };
    return { planModel, subscriptionModel, created };
  };

  it('creates a trial sub when eligible (trial plan entitlements, downgrade target = default)', async () => {
    const { planModel, subscriptionModel, created } = buildEligible();
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const sub: any = await svc.startTrial(USER_1, 'erp', NOW);

    const doc = created[0];
    expect(doc.status).toBe('trial');
    // Trial length from the trial plan (30 days).
    const expectedEnd = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(new Date(doc.trialEndsAt).getTime()).toBe(expectedEnd.getTime());
    expect(new Date(doc.currentPeriodEnd).getTime()).toBe(expectedEnd.getTime());
    // applied = trial plan entitlements; purchased = default plan (downgrade target).
    expect(doc.appliedEntitlements).toEqual(TRIAL_PLAN_ENTITLEMENTS);
    expect(doc.purchasedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.planId).toBe('default-plan');
    // The current active sub is superseded first.
    expect(subscriptionModel.findOneAndUpdate).toHaveBeenCalled();
    expect(sub._id).toBe('sub-trial');
  });

  it('throws when no trial plan is configured', async () => {
    const planModel = makePlanModel({ trialPlan: null, defaultPlan: { _id: 'default-plan' } });
    const subscriptionModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
      create: vi.fn(),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    await expect(svc.startTrial(USER_1, 'erp', NOW)).rejects.toThrow(/No trial is available/i);
    expect(subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('throws "Trial already used" when the user has EVER had a trial (status trial)', async () => {
    const { planModel, subscriptionModel } = buildEligible({
      existing: { _id: 'old', product: 'erp', status: 'trial' },
    });
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    await expect(svc.startTrial(USER_1, 'erp', NOW)).rejects.toThrow(/Trial already used/i);
    expect(subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('throws "Trial already used" when a prior sub carries trialEndedAt (lapsed trial)', async () => {
    const { planModel, subscriptionModel } = buildEligible({
      existing: { _id: 'old', product: 'erp', status: 'active', trialEndedAt: NOW },
    });
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    await expect(svc.startTrial(USER_1, 'erp', NOW)).rejects.toThrow(/Trial already used/i);
  });

  it('throws "You already have a paid plan" when the user is on a PAID (non-default) plan', async () => {
    // isOnPaidPlan does findOne({ status:'active' }); the ever-trialed lookup is
    // a separate findOne with an $or. Route by the presence of `$or`.
    const trialPlan = {
      _id: 'trial-plan',
      product: 'erp',
      trialDurationDays: 30,
      entitlements: TRIAL_PLAN_ENTITLEMENTS,
    };
    const defaultPlan = { _id: 'default-plan', product: 'erp', entitlements: FREE_ENTITLEMENTS };
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': trialPlan, 'default-plan': defaultPlan },
    });
    const subscriptionModel = {
      findOne: vi.fn((filter: any) => {
        // ever-trialed lookup (carries $or) -> no prior trial.
        if (filter?.$or) return { exec: vi.fn().mockResolvedValue(null) };
        // isOnPaidPlan active-sub lookup -> an active sub on a PAID plan.
        return {
          exec: vi.fn().mockResolvedValue({
            _id: 'paid',
            product: 'erp',
            status: 'active',
            planId: 'paid-plan',
          }),
        };
      }),
      create: vi.fn(),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    await expect(svc.startTrial(USER_1, 'erp', NOW)).rejects.toThrow(/already have a paid plan/i);
    expect(subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('a user on the FREE/default plan with no trial history is still eligible (startTrial succeeds)', async () => {
    const trialPlan = {
      _id: 'trial-plan',
      product: 'erp',
      trialDurationDays: 30,
      entitlements: TRIAL_PLAN_ENTITLEMENTS,
    };
    const defaultPlan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 0,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': trialPlan, 'default-plan': defaultPlan },
    });
    const subscriptionModel = {
      findOne: vi.fn((filter: any) => {
        if (filter?.$or) return { exec: vi.fn().mockResolvedValue(null) };
        // Active sub is on the DEFAULT plan -> NOT paid -> eligible.
        return {
          exec: vi.fn().mockResolvedValue({
            _id: 'free',
            product: 'erp',
            status: 'active',
            planId: 'default-plan',
          }),
        };
      }),
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
    expect(sub._id).toBe('sub-trial');
    expect(created[0].status).toBe('trial');
  });
});

describe('getTrialState — three states', () => {
  beforeEach(() => vi.clearAllMocks());

  it('canStartTrial=true for a fresh user on Free with a trial plan configured', async () => {
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': { trialDurationDays: 30 } },
    });
    const subscriptionModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const state = await svc.getTrialState(USER_1, 'erp');
    expect(state.trialPlanConfigured).toBe(true);
    expect(state.hasUsedTrial).toBe(false);
    expect(state.isInTrial).toBe(false);
    expect(state.trialDurationDays).toBe(30);
    expect(state.canStartTrial).toBe(true);
    expect(state.trialEndsAt).toBeNull();
  });

  it('isInTrial=true + canStartTrial=false while the user is mid-trial', async () => {
    const trialEndsAt = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': { trialDurationDays: 30 } },
    });
    const subscriptionModel = {
      findOne: vi.fn(() => ({
        exec: vi
          .fn()
          .mockResolvedValue({ _id: 'sub', product: 'erp', status: 'trial', trialEndsAt }),
      })),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const state = await svc.getTrialState(USER_1, 'erp');
    expect(state.isInTrial).toBe(true);
    expect(state.hasUsedTrial).toBe(true);
    expect(state.canStartTrial).toBe(false);
    expect(new Date(state.trialEndsAt).getTime()).toBe(trialEndsAt.getTime());
  });

  it('hasUsedTrial=true + canStartTrial=false after the trial lapsed (trialEndedAt set)', async () => {
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': { trialDurationDays: 30 } },
    });
    const subscriptionModel = {
      findOne: vi.fn(() => ({
        exec: vi
          .fn()
          .mockResolvedValue({ _id: 'sub', product: 'erp', status: 'active', trialEndedAt: NOW }),
      })),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const state = await svc.getTrialState(USER_1, 'erp');
    expect(state.hasUsedTrial).toBe(true);
    expect(state.isInTrial).toBe(false);
    expect(state.canStartTrial).toBe(false);
  });

  it('canStartTrial=false for a user on a PAID plan (no trial history)', async () => {
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': { trialDurationDays: 30 } },
    });
    const subscriptionModel = {
      findOne: vi.fn((filter: any) => {
        // ever-trialed lookup (carries $or) -> no prior trial.
        if (filter?.$or) return { exec: vi.fn().mockResolvedValue(null) };
        // isOnPaidPlan active-sub lookup -> active sub on a PAID plan.
        return {
          exec: vi.fn().mockResolvedValue({
            _id: 'paid',
            product: 'erp',
            status: 'active',
            planId: 'paid-plan',
          }),
        };
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const state = await svc.getTrialState(USER_1, 'erp');
    expect(state.trialPlanConfigured).toBe(true);
    expect(state.hasUsedTrial).toBe(false);
    expect(state.isInTrial).toBe(false);
    expect(state.canStartTrial).toBe(false);
  });

  it('canStartTrial=true for a user on the FREE/default plan (no trial history)', async () => {
    const planModel = makePlanModel({
      trialPlan: { _id: 'trial-plan' },
      defaultPlan: { _id: 'default-plan' },
      byId: { 'trial-plan': { trialDurationDays: 30 } },
    });
    const subscriptionModel = {
      findOne: vi.fn((filter: any) => {
        if (filter?.$or) return { exec: vi.fn().mockResolvedValue(null) };
        // Active sub on the DEFAULT plan -> NOT paid -> eligible.
        return {
          exec: vi.fn().mockResolvedValue({
            _id: 'free',
            product: 'erp',
            status: 'active',
            planId: 'default-plan',
          }),
        };
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const state = await svc.getTrialState(USER_1, 'erp');
    expect(state.canStartTrial).toBe(true);
  });
});

describe('convert-during-trial — subscribe() supersedes the trial', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a user in a trial who subscribes to a paid plan ends with the trial superseded + new active sub', async () => {
    const paidPlan = {
      _id: 'paid-plan',
      product: 'erp',
      isActive: true,
      tier: 'growth',
      entitlements: TRIAL_PLAN_ENTITLEMENTS,
    };
    const currentTrial: any = {
      _id: 'trial-sub',
      status: 'trial',
      planId: { _id: 'default-plan', tier: 'free' },
      currentPeriodEnd: new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000),
    };
    const created: any[] = [];
    const supersedeArgs: any[] = [];
    const planModel = {
      findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(paidPlan) })),
    };
    const subscriptionModel: any = vi.fn().mockImplementation((doc: any) => ({
      ...doc,
      save: vi.fn().mockImplementation(function (this: any) {
        const saved = { _id: 'paid-sub', ...doc };
        created.push(saved);
        return Promise.resolve(saved);
      }),
    }));
    subscriptionModel.findOne = vi.fn(() => ({
      sort: vi.fn(() => ({
        populate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(currentTrial) })),
      })),
    }));
    // supersedeCurrent internals.
    subscriptionModel.updateMany = vi.fn((filter: any) => {
      supersedeArgs.push(filter);
      return { exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) };
    });
    subscriptionModel.findOneAndUpdate = vi.fn((filter: any) => {
      supersedeArgs.push(filter);
      return { exec: vi.fn().mockResolvedValue(currentTrial) };
    });

    const svc = buildSvc({ planModel, subscriptionModel });
    // addOnsService.handleSubscriptionChange is invoked after a paid activation.
    (svc as any).addOnsService = { handleSubscriptionChange: vi.fn().mockResolvedValue(undefined) };

    const result: any = await svc.subscribe(USER_1, {
      planId: 'paid-plan',
      billingCycle: 'monthly',
      activateImmediately: true,
    } as any);

    // The trial was superseded (findOneAndUpdate over active/trial statuses).
    const supersededActiveTrial = supersedeArgs.find(
      (f) => Array.isArray(f?.status?.$in) && f.status.$in.includes('trial'),
    );
    expect(supersededActiveTrial).toBeDefined();
    // A new active paid sub now exists.
    expect(result._id).toBe('paid-sub');
    expect(result.status).toBe('active');
    expect(created[0].planId).toBe('paid-plan');
  });
});
