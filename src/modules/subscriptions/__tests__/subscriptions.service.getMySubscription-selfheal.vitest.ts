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
 * Self-heal in getMySubscription (2026-06-24).
 *
 * A new public signup calls createFreeSubscription at signup, but the created
 * sub can be orphaned (userId divergence in the signup flow), so the logged-in
 * user resolves to NO active/trial ERP sub on the first dashboard load. This
 * self-heal re-runs createFreeSubscription (idempotent) at the read path so the
 * user always lands on the default plan. These specs pin:
 *   1. No active/trial ERP sub + free tier ON  → heal fires, re-query returns
 *      the newly-created active ERP sub → non-null subscription + entitlements.
 *   2. No sub + free tier OFF (createFreeSubscription → null) → no heal, null.
 *   3. Existing active ERP sub → first lookup returns it; heal does NOT fire.
 *   4. createFreeSubscription throws → swallowed, returns the no-sub result.
 */

// A real ObjectId-shaped 24-hex string so `new Types.ObjectId(userId)` works.
const USER_ID = '6650000000000000000000a1';

const FREE_ENTITLEMENTS = {
  maxWorkspaces: 1,
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  modules: ['team', 'attendance', 'salary'],
  features: { export: false },
  moduleAccess: buildModuleAccess('free'),
};

const buildSvc = (deps: { subscriptionModel?: any; appSettingsModel?: any }) => {
  return new SubscriptionsService(
    {} as any, // planModel
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
};

// Build a fake subscription doc that satisfies the active/trial ERP first
// lookup: findOne(...).sort(...).populate('planId').exec(), then `.toObject()`.
const erpSubDoc = (overrides: Record<string, unknown> = {}) => {
  const doc: any = {
    _id: 'erp-sub',
    userId: USER_ID,
    product: 'erp',
    status: 'active',
    appliedEntitlements: FREE_ENTITLEMENTS,
    planId: { _id: 'plan-1', tier: 'free' },
    ...overrides,
  };
  doc.toObject = () => ({ ...doc });
  return doc;
};

// findOne(...).sort().populate().exec()  AND  findOne(...).populate().lean()
// (the scheduled lookup) — return queued results in call order.
const makeFindOne = (results: any[]) => {
  let i = 0;
  return vi.fn(() => {
    const value = results[i] ?? null;
    i += 1;
    const chain: any = {
      sort: () => chain,
      populate: () => chain,
      exec: vi.fn().mockResolvedValue(value),
      lean: vi.fn().mockResolvedValue(value),
    };
    return chain;
  });
};

describe('SubscriptionsService getMySubscription — self-heal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('heals: no active/trial ERP sub + free tier ON → createFreeSubscription fires, re-query returns the new sub', async () => {
    const healed = erpSubDoc();
    // Call order of subscriptionModel.findOne in getMySubscription:
    //   1. active/trial ERP lookup            → null (no sub)
    //   2. cancelled-grace lookup             → null
    //   3. self-heal re-query (same shape)    → the healed sub
    //   4. scheduled lookup                   → null
    const subscriptionModel = {
      findOne: makeFindOne([null, null, healed, null]),
      // entitlement-normalization write path (fires only if tier-normalization changed something)
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const svc = buildSvc({ subscriptionModel });

    // Spy on createFreeSubscription so we don't exercise its internals here.
    const createSpy = vi
      .spyOn(svc, 'createFreeSubscription')
      .mockResolvedValue({ _id: 'erp-sub' } as any);

    const result: any = await svc.getMySubscription(USER_ID);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(USER_ID, 'self');
    expect(result.subscription).not.toBeNull();
    expect(result.subscription._id).toBe('erp-sub');
    // Entitlements come from the re-queried sub (tier-normalization may augment
    // them, so assert presence/shape rather than exact equality).
    expect(result.entitlements).not.toBeNull();
    expect(result.entitlements.maxMembersPerWorkspace).toBe(5);
    expect(result.plan).toEqual({ _id: 'plan-1', tier: 'free' });
  });

  it('no heal: free tier OFF → createFreeSubscription returns null → getMySubscription returns null sub', async () => {
    const subscriptionModel = {
      // 1.active/trial null  2.cancelled null  3.scheduled null  (no re-query — create returned null)
      findOne: makeFindOne([null, null, null]),
    };
    const svc = buildSvc({ subscriptionModel });

    const createSpy = vi.spyOn(svc, 'createFreeSubscription').mockResolvedValue(null as any);

    const result: any = await svc.getMySubscription(USER_ID);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.subscription).toBeNull();
    expect(result.entitlements).toBeNull();
    expect(result.plan).toBeNull();
  });

  it('no heal: existing active ERP sub → first lookup returns it, createFreeSubscription is NOT called', async () => {
    const existing = erpSubDoc({ _id: 'pre-existing-erp' });
    const subscriptionModel = {
      // 1.active/trial → existing  2.scheduled → null  (cancelled-grace skipped since sub found)
      findOne: makeFindOne([existing, null]),
      // entitlement-normalization write path (fires only if tier-normalization changed something)
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const svc = buildSvc({ subscriptionModel });

    const createSpy = vi.spyOn(svc, 'createFreeSubscription');

    const result: any = await svc.getMySubscription(USER_ID);

    expect(createSpy).not.toHaveBeenCalled();
    expect(result.subscription._id).toBe('pre-existing-erp');
    expect(result.entitlements).not.toBeNull();
    expect(result.entitlements.maxMembersPerWorkspace).toBe(5);
  });

  it('swallows errors: createFreeSubscription throws → no crash, returns the no-sub result', async () => {
    const subscriptionModel = {
      findOne: makeFindOne([null, null, null]),
    };
    const svc = buildSvc({ subscriptionModel });

    const createSpy = vi.spyOn(svc, 'createFreeSubscription').mockRejectedValue(new Error('boom'));

    const result: any = await svc.getMySubscription(USER_ID);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.subscription).toBeNull();
    expect(result.entitlements).toBeNull();
  });
});
