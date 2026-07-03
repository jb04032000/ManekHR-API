import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SubscriptionsService so the
// transitive schema imports (Plan, Subscription, Tier, Workspace, etc.) don't
// trip vitest's "Cannot determine type" reflect-metadata error. All Models are
// injected as plain mocks; Mongoose is never actually exercised here.
// (Same decorator-mock pattern as connect-normalization.vitest.ts and
// attendance-plan-migration.service.vitest.ts.)
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

import { buildModuleAccess } from '../../../common/constants/module-features.registry';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';
import { SubscriptionsService } from '../subscriptions.service';

// ---------------------------------------------------------------------------
// REGRESSION: tier-enum drift bug in repairMissingSubFeatures.
//
// The OLD tierToKey map inside repairMissingSubFeatures downgraded
//   growth   -> 'starter'
//   business -> 'pro'
// so when the repair backfilled a MISSING sub-feature key on a growth/business
// subscription it pulled the LOWER tier's (locked/absent) default instead of
// the subscription's own (full) entitlement — silently stripping paid features
// on every boot repair pass. After the fix the map passes the tier through
// unchanged: growth -> growth, business -> business.
//
// These tests assert the END STATE of the patched moduleAccess: a growth plan
// retains its growth-only FULL sub-features (which would FAIL under the buggy
// growth->starter map, because starter has them LOCKED / absent).
// ---------------------------------------------------------------------------

type ModuleAccess = ReturnType<typeof buildModuleAccess>;

function subFeatureAccess(
  access: ModuleAccess,
  module: AppModule,
  key: string,
): string | undefined {
  return access.find((m) => m.module === module)?.subFeatures.find((sf) => sf.key === key)?.access;
}

/**
 * Build a SubscriptionsService backed by mock models. We only exercise the
 * subscription branch of repairMissingSubFeatures, so only the subscription
 * model's find/populate/lean/updateOne chain has to behave. The plan model is
 * stubbed to return no plans.
 */
function makeService(subDocs: any[]) {
  const planModel: any = {
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const subscriptionModel: any = {
    find: vi.fn().mockReturnValue({
      populate: () => ({ lean: () => Promise.resolve(subDocs) }),
    }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const noopModel: any = {};

  // SubscriptionsService constructor positional args: planModel,
  // subscriptionModel, then assorted models / services we don't touch here.
  const service = new SubscriptionsService(
    planModel,
    subscriptionModel,
    noopModel,
    noopModel,
    noopModel,
    noopModel,
    noopModel,
    noopModel,
  );
  return { service, subscriptionModel };
}

function patchedAccessFrom(subscriptionModel: any): ModuleAccess {
  expect(subscriptionModel.updateOne).toHaveBeenCalledTimes(1);
  const setArg = subscriptionModel.updateOne.mock.calls[0][1].$set;
  return setArg['appliedEntitlements.moduleAccess'] as ModuleAccess;
}

describe('repairMissingSubFeatures — tier-enum drift regression', () => {
  it('growth sub: backfills SALARY.statutory_compliance as FULL (growth default), NOT LOCKED (starter)', async () => {
    // Growth subscription whose SALARY module is MISSING the
    // statutory_compliance key (simulating a key added after seeding). The
    // repair must backfill it as FULL — the growth tier default. Under the
    // buggy growth->starter map it would have been backfilled LOCKED.
    const growthSub: any = {
      _id: 'sub-growth',
      userId: 'user-1',
      planId: { tier: 'growth' },
      appliedEntitlements: {
        moduleAccess: [
          {
            module: AppModule.SALARY,
            enabled: true,
            subFeatures: [{ key: 'generate_payroll', access: FeatureAccessLevel.FULL }],
          },
        ],
      },
    };

    const { service, subscriptionModel } = makeService([growthSub]);
    await service.repairMissingSubFeatures();

    const patched = patchedAccessFrom(subscriptionModel);
    expect(subFeatureAccess(patched, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.FULL,
    );
    expect(subFeatureAccess(patched, AppModule.SALARY, 'payslip_generation')).toBe(
      FeatureAccessLevel.FULL,
    );
  });

  it('growth sub: keeps LEAVE entitlement FULL when backfilled (growth -> growth)', async () => {
    const growthSub: any = {
      _id: 'sub-growth-leave',
      userId: 'user-1b',
      planId: { tier: 'growth' },
      appliedEntitlements: {
        moduleAccess: [
          {
            module: AppModule.LEAVE,
            enabled: true,
            subFeatures: [], // all leave keys missing
          },
        ],
      },
    };

    const { service, subscriptionModel } = makeService([growthSub]);
    await service.repairMissingSubFeatures();

    const patched = patchedAccessFrom(subscriptionModel);
    expect(subFeatureAccess(patched, AppModule.LEAVE, 'apply')).toBe(FeatureAccessLevel.FULL);
    expect(subFeatureAccess(patched, AppModule.LEAVE, 'approve')).toBe(FeatureAccessLevel.FULL);
  });

  it('business sub: backfills SALARY.statutory_compliance as FULL (business default), NOT pro/starter', async () => {
    // Under the buggy business->pro map this resolved to the legacy 'pro'
    // tier. The pass-through map resolves business -> business; statutory
    // payroll is FULL there (cumulative from growth).
    const businessSub: any = {
      _id: 'sub-business',
      userId: 'user-2',
      planId: { tier: 'business' },
      appliedEntitlements: {
        moduleAccess: [
          {
            module: AppModule.SALARY,
            enabled: true,
            subFeatures: [{ key: 'generate_payroll', access: FeatureAccessLevel.FULL }],
          },
        ],
      },
    };

    const { service, subscriptionModel } = makeService([businessSub]);
    await service.repairMissingSubFeatures();

    const patched = patchedAccessFrom(subscriptionModel);
    expect(subFeatureAccess(patched, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.FULL,
    );
  });
});
