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
vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { SubscriptionsService } from '../subscriptions.service';

/**
 * Phase-2 ERP pricing — post-expiry "you're now on Free" notice.
 *
 * downgradeToBasePlan is the single choke point for "a trial just became
 * Free". It fires exactly ONE notice per subscription (deduped via the
 * MarketingService unique key `trial-ended:<subId>`), and the dispatch is
 * best-effort: a failure must never bubble out of the downgrade.
 */
const NOW = new Date('2026-06-23T00:00:00.000Z');

const FREE_ENTITLEMENTS = {
  maxWorkspaces: 1,
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  modules: ['team', 'attendance', 'salary'],
  features: { export: false },
};

const buildSvc = (deps: { subscriptionModel?: any; userModel?: any; marketing?: any }) =>
  new SubscriptionsService(
    {} as any, // planModel
    deps.subscriptionModel ?? ({} as any), // subscriptionModel
    {} as any, // appSettingsModel
    {} as any, // tierModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // addOnsService
    {} as any, // singleFlight
    deps.userModel ?? ({} as any), // userModel (appended)
    deps.marketing ?? ({} as any), // marketing (appended)
  );

const userModelReturning = (user: any) => ({
  findById: vi.fn(() => ({
    select: vi.fn(() => ({ lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(user) })) })),
  })),
});

// A MarketingService stub. buildAppUrl is needed because sendTrialEndedNotice
// builds the upgrade URL through it before dispatching.
const marketingMock = (notice: any) => ({
  sendTrialEndedNotice: notice,
  buildAppUrl: vi.fn((p: string) => `https://app.example${p}`),
});

describe('downgradeToBasePlan — post-expiry notice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches the trial-ended notice exactly once on a real downgrade', async () => {
    const subscriptionModel = {
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const marketing = marketingMock(vi.fn().mockResolvedValue(true));
    const userModel = userModelReturning({ name: 'Asha', email: 'asha@example.com' });
    const svc = buildSvc({ subscriptionModel, marketing, userModel });

    const sub: any = {
      _id: 'sub-1',
      userId: 'user-1',
      status: 'trial',
      trialEndsAt: new Date(NOW.getTime() - 1000),
      purchasedEntitlements: FREE_ENTITLEMENTS,
    };

    const changed = await (svc as any).downgradeToBasePlan(sub, NOW);
    expect(changed).toBe(true);
    expect(marketing.sendTrialEndedNotice).toHaveBeenCalledTimes(1);
    const arg = marketing.sendTrialEndedNotice.mock.calls[0][0];
    expect(arg.subscriptionId).toBe('sub-1');
    expect(arg.userId).toBe('user-1');
    expect(arg.recipientEmail).toBe('asha@example.com');
  });

  it('does NOT re-send when downgradeToBasePlan is called again on the now-active sub (idempotent)', async () => {
    const subscriptionModel = {
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const marketing = marketingMock(vi.fn().mockResolvedValue(true));
    const userModel = userModelReturning({ name: 'Asha', email: 'asha@example.com' });
    const svc = buildSvc({ subscriptionModel, marketing, userModel });

    // First call: a genuine lapsed trial -> downgrade + notice.
    await (svc as any).downgradeToBasePlan(
      {
        _id: 'sub-1',
        userId: 'user-1',
        status: 'trial',
        trialEndsAt: new Date(NOW.getTime() - 1000),
        purchasedEntitlements: FREE_ENTITLEMENTS,
      },
      NOW,
    );

    // Second call: the sub is now active + no trialEndsAt (already downgraded).
    // The early idempotency guard returns before any notice dispatch.
    const changed = await (svc as any).downgradeToBasePlan(
      {
        _id: 'sub-1',
        userId: 'user-1',
        status: 'active',
        trialEndsAt: null,
        purchasedEntitlements: FREE_ENTITLEMENTS,
      },
      NOW,
    );

    expect(changed).toBe(false);
    expect(marketing.sendTrialEndedNotice).toHaveBeenCalledTimes(1);
  });

  it('does not throw out of the downgrade when the notice dispatch fails', async () => {
    const subscriptionModel = {
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const marketing = marketingMock(vi.fn().mockRejectedValue(new Error('SMTP down')));
    const userModel = userModelReturning({ name: 'Asha', email: 'asha@example.com' });
    const svc = buildSvc({ subscriptionModel, marketing, userModel });

    const sub: any = {
      _id: 'sub-1',
      userId: 'user-1',
      status: 'trial',
      trialEndsAt: new Date(NOW.getTime() - 1000),
      purchasedEntitlements: FREE_ENTITLEMENTS,
    };

    // The downgrade still succeeds + returns true despite the dispatch throwing.
    const changed = await (svc as any).downgradeToBasePlan(sub, NOW);
    expect(changed).toBe(true);
    expect(subscriptionModel.updateOne).toHaveBeenCalledOnce();
  });

  it('still downgrades when the user has no email (notice skipped, no throw)', async () => {
    const subscriptionModel = {
      updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const marketing = marketingMock(vi.fn().mockResolvedValue(false));
    const userModel = userModelReturning(null); // user vanished / no record
    const svc = buildSvc({ subscriptionModel, marketing, userModel });

    const changed = await (svc as any).downgradeToBasePlan(
      {
        _id: 'sub-1',
        userId: 'user-1',
        status: 'trial',
        trialEndsAt: new Date(NOW.getTime() - 1000),
        purchasedEntitlements: FREE_ENTITLEMENTS,
      },
      NOW,
    );

    expect(changed).toBe(true);
    expect(marketing.sendTrialEndedNotice).not.toHaveBeenCalled();
  });
});
