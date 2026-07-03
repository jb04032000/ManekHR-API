/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing the guard — transitive decorated
// schema imports would otherwise trip vitest's reflect-metadata pipeline.
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

import { SubscriptionGuard, REQUIRE_SUBSCRIPTION_KEY } from '../subscription.guard';
import { AppModule } from '../../enums/modules.enum';
import { buildModuleAccess } from '../../constants/module-features.registry';

/**
 * Phase-2 ERP pricing — the guard must NOT lock out a user whose trial simply
 * elapsed. When `currentPeriodEnd < now` on a trial/free sub it resolves the
 * DOWNGRADED (plan-real) entitlements and returns those, so the user keeps
 * Free-level access instead of a "No active plan" Forbidden.
 */

// The plan's real Free entitlements (what the lapsed trial downgrades to).
const FREE_ENTITLEMENTS = {
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  moduleAccess: buildModuleAccess('free'),
};

// A valid 24-char hex ObjectId — the guard wraps user.sub in new Types.ObjectId().
const USER_ID = '0123456789abcdef01234567';

const makeContext = (requirements: any[]) => {
  const request: any = {
    user: { sub: USER_ID },
    params: {},
    headers: {},
    method: 'GET',
  };
  return {
    request,
    ctx: {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => request }),
    } as any,
    requirements,
  };
};

describe('SubscriptionGuard — lapsed trial downgrades instead of locking out', () => {
  let reflector: any;
  let subscriptionModel: any;
  let workspaceModel: any;
  let billingPolicy: any;

  beforeEach(() => {
    reflector = { get: vi.fn() };
    workspaceModel = { findById: vi.fn() };
    billingPolicy = { getPolicy: vi.fn().mockResolvedValue({}) };
    subscriptionModel = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
  });

  it('returns true (Free access) for an elapsed trial sub rather than throwing No active plan', async () => {
    // A trial sub whose period has lapsed; it still carries the base limits it
    // should downgrade to.
    const lapsed: any = {
      _id: 'sub-1',
      status: 'trial',
      trialEndsAt: new Date(Date.now() - 1000),
      currentPeriodEnd: new Date(Date.now() - 1000),
      purchasedEntitlements: FREE_ENTITLEMENTS,
      // Full-access trial entitlements that must NOT be used post-lapse.
      appliedEntitlements: { ...FREE_ENTITLEMENTS, maxMembersPerWorkspace: -1 },
      planId: { entitlements: FREE_ENTITLEMENTS, toObject: () => ({}) },
      toObject() {
        return { ...this };
      },
    };
    subscriptionModel.findOne = vi.fn(() => ({
      sort: vi.fn(() => ({
        populate: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(lapsed) })),
      })),
    }));

    const guard = new SubscriptionGuard(
      reflector,
      subscriptionModel,
      workspaceModel,
      billingPolicy,
    );

    // Require the ATTENDANCE module (enabled on free) — would 403 if entitlements
    // came back null.
    const requirement = { module: AppModule.ATTENDANCE };
    reflector.get = vi.fn((key: string, target: any) =>
      key === REQUIRE_SUBSCRIPTION_KEY && target === 'handler' ? [requirement] : [],
    );

    const { ctx } = makeContext([requirement]);
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    // It persisted the downgrade (active + free entitlements), did not expire.
    expect(subscriptionModel.updateOne).toHaveBeenCalledTimes(1);
    const setArg = subscriptionModel.updateOne.mock.calls[0][1].$set;
    expect(setArg.status).toBe('active');
    expect(setArg.appliedEntitlements).toEqual(FREE_ENTITLEMENTS);
    expect(setArg.trialEndsAt).toBeNull();
  });
});
