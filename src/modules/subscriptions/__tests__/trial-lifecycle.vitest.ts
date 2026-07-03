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
 * Phase-2 ERP pricing rework — trial lifecycle.
 *
 * Opt-in model (2026-06-24): createFreeSubscription NO LONGER auto-starts a
 * trial. A new account ALWAYS lands on the DEFAULT plan as status:'active'
 * (no trialEndsAt), regardless of any configured trial plan or the default
 * plan's trialDurationDays — the trial is started explicitly via startTrial()
 * (covered in opt-in-trial.vitest.ts). On a later trial expiry the account
 * downgrades to Free and is NEVER locked out. These specs pin:
 *   - createFreeSubscription always yields status:'active' on the default plan,
 *     applied === purchased === plan entitlements, currentPeriodEnd far-future.
 *   - freeTierEnabled === false → null (unchanged guard).
 *   - downgradeToBasePlan flips a lapsed trial to the plan's real entitlements
 *     (status:'active', not 'expired'), idempotently.
 *   - the expire cron downgrades lapsed trials instead of locking them.
 */

// A fixed clock so trialEndsAt / currentPeriodEnd are deterministic.
const NOW = new Date('2026-06-23T00:00:00.000Z');

// Valid 24-char hex user ids — createFreeSubscription wraps userId in
// `new Types.ObjectId(...)`, which rejects non-hex strings.
const USER_1 = '0123456789abcdef01234561';
const USER_2 = '0123456789abcdef01234562';
const USER_4 = '0123456789abcdef01234564';
const USER_5 = '0123456789abcdef01234565';
const USER_6 = '0123456789abcdef01234566';

// The plan's REAL Free entitlements (what the trial downgrades to).
const FREE_ENTITLEMENTS = {
  maxWorkspaces: 1,
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  modules: ['team', 'attendance', 'salary'],
  features: { export: false },
  moduleAccess: buildModuleAccess('free'),
};

const buildSvc = (deps: { planModel?: any; subscriptionModel?: any; appSettingsModel?: any }) => {
  return new SubscriptionsService(
    deps.planModel ?? ({} as any), // planModel
    deps.subscriptionModel ?? ({} as any), // subscriptionModel
    deps.appSettingsModel ?? ({} as any), // appSettingsModel
    {} as any, // tierModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // addOnsService
    {} as any, // singleFlight
    {} as any, // userModel (appended — post-expiry notice lookup)
    {} as any, // marketing (appended — post-expiry notice dispatch)
  );
};

const appSettings = (overrides: Record<string, unknown> = {}) => ({
  findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ ...overrides }) })),
});

/**
 * The idempotency guard in createFreeSubscription is ERP-scoped + active/trial
 * (mirrors getMySubscription's ERP resolver). This findOne mock behaves like the
 * DB: it returns the seeded sub ONLY when that sub actually satisfies the query's
 * product ($in) and status ($in) constraints. So a Connect sub (product:'connect')
 * or a stale/expired ERP sub will NOT match the scoped guard query and must not
 * block ERP creation — but an active/trial ERP sub will.
 */
const scopedFindOne = (existingSub: any) =>
  vi.fn((filter: any) => {
    let matches = !!existingSub;
    if (existingSub && filter?.product?.$in) {
      matches = matches && filter.product.$in.includes(existingSub.product);
    }
    if (existingSub && filter?.status?.$in) {
      matches = matches && filter.status.$in.includes(existingSub.status);
    }
    return { exec: vi.fn().mockResolvedValue(matches ? existingSub : null) };
  });

describe('SubscriptionsService trial lifecycle — createFreeSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opt-in: creates an ACTIVE default sub even when the default plan has trialDurationDays > 0', async () => {
    const plan = {
      _id: 'default-plan',
      product: 'erp',
      // A positive trialDurationDays must NOT auto-start a trial any more.
      trialDurationDays: 14,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = {
      // getDefaultPlanId resolves the isDefault plan id.
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ _id: 'default-plan' }) })),
      findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(plan) })),
    };
    const subscriptionModel = {
      findOne: scopedFindOne(null),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'sub-1', ...doc });
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const sub: any = await svc.createFreeSubscription(USER_1, 'self', NOW);

    // Resolved via getDefaultPlanId -> findById, NOT the hardcoded FREE-tier findOne.
    expect(planModel.findById).toHaveBeenCalledWith('default-plan');

    const doc = created[0];
    // ACTIVE on the DEFAULT plan — NOT a trial (auto-start is off).
    expect(doc.status).toBe('active');
    expect(doc.trialEndsAt).toBeUndefined();
    // applied === purchased === plan entitlements (no full-access trial unlock).
    expect(doc.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.purchasedEntitlements).toEqual(FREE_ENTITLEMENTS);
    // currentPeriodEnd is far-future (never expires on its own).
    expect(new Date(doc.currentPeriodEnd).getFullYear()).toBeGreaterThan(NOW.getFullYear() + 50);

    expect(sub._id).toBe('sub-1');
  });

  it('creates an ACTIVE subscription on the default plan (trialDurationDays === 0)', async () => {
    const plan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 0,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ _id: 'default-plan' }) })),
      findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(plan) })),
    };
    const subscriptionModel = {
      findOne: scopedFindOne(null),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'sub-2', ...doc });
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    await svc.createFreeSubscription(USER_2, 'self', NOW);

    const doc = created[0];
    expect(doc.status).toBe('active');
    expect(doc.trialEndsAt).toBeUndefined();
    // applied === purchased === plan entitlements.
    expect(doc.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(doc.purchasedEntitlements).toEqual(FREE_ENTITLEMENTS);
    // currentPeriodEnd is far-future (never expires).
    expect(new Date(doc.currentPeriodEnd).getFullYear()).toBeGreaterThan(NOW.getFullYear() + 50);
  });

  it('returns null when freeTierEnabled is false (unchanged guard)', async () => {
    const svc = buildSvc({
      appSettingsModel: appSettings({ freeTierEnabled: false }),
    });
    const result = await svc.createFreeSubscription('0123456789abcdef01234563', 'self', NOW);
    expect(result).toBeNull();
  });

  it('CREATES an ERP sub even when the user already has an ACTIVE CONNECT sub (signup-bug repro)', async () => {
    // Bug: the old guard `findOne({ userId })` matched ANY sub — a Connect sub
    // created at signup short-circuited ERP creation, leaving no active ERP plan.
    // The scoped guard ignores the Connect sub (different product) and creates ERP.
    const connectSub = {
      _id: 'connect-sub',
      userId: USER_4,
      product: 'connect',
      status: 'active',
    };
    const plan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 0,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ _id: 'default-plan' }) })),
      findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(plan) })),
    };
    const subscriptionModel = {
      // Connect sub exists, but the scoped (erp/bundle + active/trial) guard query
      // must NOT match it — so this returns null for the guard and ERP is created.
      findOne: scopedFindOne(connectSub),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'erp-sub', ...doc });
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const sub: any = await svc.createFreeSubscription(USER_4, 'self', NOW);

    // A NEW active ERP sub was created — the Connect sub was not returned.
    expect(subscriptionModel.create).toHaveBeenCalledTimes(1);
    expect(created[0].product).toBe('erp');
    expect(created[0].status).toBe('active');
    expect(sub._id).toBe('erp-sub');
    expect(sub._id).not.toBe('connect-sub');
  });

  it('CREATES a fresh active ERP sub when the user only has a STALE/EXPIRED ERP sub', async () => {
    // An expired/superseded ERP sub is not active/trial, so the scoped guard
    // does not match it and a fresh active ERP sub is created.
    const plan = {
      _id: 'default-plan',
      product: 'erp',
      trialDurationDays: 0,
      entitlements: FREE_ENTITLEMENTS,
    };
    const created: any[] = [];
    const planModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ _id: 'default-plan' }) })),
      findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(plan) })),
    };
    const subscriptionModel = {
      // scopedFindOne(null): nothing matches the active/trial-erp guard query
      // (the only existing sub is expired), so ERP is created.
      findOne: scopedFindOne(null),
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: 'erp-sub-fresh', ...doc });
      }),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const sub: any = await svc.createFreeSubscription(USER_5, 'self', NOW);

    expect(subscriptionModel.create).toHaveBeenCalledTimes(1);
    expect(created[0].product).toBe('erp');
    expect(created[0].status).toBe('active');
    expect(sub._id).toBe('erp-sub-fresh');
  });

  it('is idempotent — returns the existing ACTIVE ERP sub and creates nothing', async () => {
    const existingErp = {
      _id: 'existing-erp',
      userId: USER_6,
      product: 'erp',
      status: 'active',
    };
    const planModel = {
      findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ _id: 'default-plan' }) })),
      findById: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
    };
    const subscriptionModel = {
      // The scoped guard query matches the existing active ERP sub.
      findOne: scopedFindOne(existingErp),
      create: vi.fn(),
    };
    const svc = buildSvc({
      planModel,
      subscriptionModel,
      appSettingsModel: appSettings({ freeTierEnabled: true }),
    });

    const sub: any = await svc.createFreeSubscription(USER_6, 'self', NOW);

    expect(sub).toBe(existingErp);
    expect(subscriptionModel.create).not.toHaveBeenCalled();
  });
});

describe('SubscriptionsService trial lifecycle — downgradeToBasePlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downgrades a lapsed trial to the plan real entitlements (active, NOT expired)', async () => {
    const updates: any[] = [];
    const subscriptionModel = {
      updateOne: vi.fn((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
      }),
    };
    const svc = buildSvc({ subscriptionModel });

    const sub: any = {
      _id: 'sub-1',
      status: 'trial',
      trialEndsAt: new Date(NOW.getTime() - 1000),
      purchasedEntitlements: FREE_ENTITLEMENTS,
    };

    const changed = await (svc as any).downgradeToBasePlan(sub, NOW);
    expect(changed).toBe(true);

    const { update } = updates[0];
    const set = update.$set;
    expect(set.status).toBe('active');
    expect(set.status).not.toBe('expired');
    expect(set.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
    // trialEndsAt cleared so it is not re-processed.
    expect(set.trialEndsAt).toBeNull();
    // trialEndedAt stamped with the SAME `now` the downgrade uses — durable
    // signal that drives the web post-expiry "your trial ended" banner.
    expect(set.trialEndedAt).toBeInstanceOf(Date);
    expect(new Date(set.trialEndedAt).getTime()).toBe(NOW.getTime());
    // currentPeriodEnd far-future — free plan never expires again.
    expect(new Date(set.currentPeriodEnd).getFullYear()).toBeGreaterThan(NOW.getFullYear() + 50);
  });

  it('falls back to populated planId.entitlements when purchasedEntitlements is missing', async () => {
    const updates: any[] = [];
    const subscriptionModel = {
      updateOne: vi.fn((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
      }),
    };
    const svc = buildSvc({ subscriptionModel });

    const sub: any = {
      _id: 'sub-1',
      status: 'trial',
      trialEndsAt: new Date(NOW.getTime() - 1000),
      // no purchasedEntitlements
      planId: { entitlements: FREE_ENTITLEMENTS },
    };

    await (svc as any).downgradeToBasePlan(sub, NOW);
    expect(updates[0].update.$set.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
  });

  it('is idempotent — an already-downgraded sub (active, no trialEndsAt) is left alone', async () => {
    const subscriptionModel = {
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) })),
    };
    const svc = buildSvc({ subscriptionModel });

    const sub: any = {
      _id: 'sub-1',
      status: 'active',
      trialEndsAt: null,
      purchasedEntitlements: FREE_ENTITLEMENTS,
    };

    const changed = await (svc as any).downgradeToBasePlan(sub, NOW);
    expect(changed).toBe(false);
    expect(subscriptionModel.updateOne).not.toHaveBeenCalled();
  });

  it('does NOT overwrite trialEndedAt on the idempotent early-return (keeps the original stamp)', async () => {
    const subscriptionModel = {
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) })),
    };
    const svc = buildSvc({ subscriptionModel });

    // An already-downgraded sub that was stamped at an earlier downgrade.
    const originalTrialEndedAt = new Date('2026-06-01T00:00:00.000Z');
    const sub: any = {
      _id: 'sub-1',
      status: 'active',
      trialEndsAt: null,
      trialEndedAt: originalTrialEndedAt,
      purchasedEntitlements: FREE_ENTITLEMENTS,
    };

    const changed = await (svc as any).downgradeToBasePlan(sub, NOW);
    // No write at all, so the original trialEndedAt stamp is preserved untouched.
    expect(changed).toBe(false);
    expect(subscriptionModel.updateOne).not.toHaveBeenCalled();
    expect(sub.trialEndedAt).toBe(originalTrialEndedAt);
  });
});

describe('SubscriptionsService trial lifecycle — runExpireStaleSubscriptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downgrades a lapsed trial sub instead of marking it expired/locked', async () => {
    const updates: any[] = [];
    const lapsedTrial: any = {
      _id: 'sub-1',
      status: 'trial',
      trialEndsAt: new Date(NOW.getTime() - 1000),
      currentPeriodEnd: new Date(NOW.getTime() - 1000),
      purchasedEntitlements: FREE_ENTITLEMENTS,
    };
    const subscriptionModel = {
      // The cron first selects lapsed trial subs to downgrade (find().populate().exec()).
      find: vi.fn(() => ({
        populate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue([lapsedTrial]) })),
      })),
      // Then any genuinely-expired PAID subs (no trialEndsAt) get the legacy treatment.
      updateMany: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) })),
      updateOne: vi.fn((filter: any, update: any) => {
        updates.push({ filter, update });
        return { exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
      }),
    };
    const svc = buildSvc({ subscriptionModel });

    await (svc as any).runExpireStaleSubscriptions(NOW);

    // The lapsed trial was DOWNGRADED (active + free entitlements), not expired.
    const downgrade = updates.find((u) => u.filter._id === 'sub-1');
    expect(downgrade).toBeDefined();
    expect(downgrade.update.$set.status).toBe('active');
    expect(downgrade.update.$set.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
  });
});
