import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SubscriptionsService so the
// transitive schema imports (Plan, Subscription, Tier, Workspace, etc.) don't
// trip vitest's "Cannot determine type" reflect-metadata error. All Models are
// injected as plain mocks; Mongoose is never actually exercised here.
// (Same decorator-mock pattern as attendance-plan-migration.service.vitest.ts.)
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
// Helpers
// ---------------------------------------------------------------------------

type ModuleAccess = ReturnType<typeof buildModuleAccess>;

function findModule(access: ModuleAccess, module: AppModule) {
  return access.find((m) => m.module === module);
}

function subFeatureAccess(
  access: ModuleAccess,
  module: AppModule,
  key: string,
): string | undefined {
  return findModule(access, module)?.subFeatures.find((sf) => sf.key === key)?.access;
}

// ---------------------------------------------------------------------------
// Part 1 — buildModuleAccess END-STATE per the owner-confirmed plan map
// ---------------------------------------------------------------------------

describe('buildModuleAccess — owner-confirmed plan -> module mapping', () => {
  it('free: Shifts enabled (basic), Leave/Regularization/Manufacturing OFF, salary statutory + bulk attendance LOCKED', () => {
    const access = buildModuleAccess('free');

    expect(findModule(access, AppModule.SHIFTS)?.enabled).toBe(true);
    expect(findModule(access, AppModule.LEAVE)?.enabled).toBe(false);
    expect(findModule(access, AppModule.REGULARIZATION)?.enabled).toBe(false);
    expect(findModule(access, AppModule.MANUFACTURING)?.enabled).toBe(false);

    // Free Shifts stays "basic": the create/edit/delete sub-features are LOCKED.
    expect(subFeatureAccess(access, AppModule.SHIFTS, 'create_shift')).toBe(
      FeatureAccessLevel.LOCKED,
    );

    // Salary statutory + attendance bulk are LOCKED on free.
    expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.LOCKED,
    );
    expect(subFeatureAccess(access, AppModule.ATTENDANCE, 'bulk_mark')).toBe(
      FeatureAccessLevel.LOCKED,
    );
  });

  it('starter: Leave + Regularization ON (apply FULL), Shifts create FULL, salary statutory still LOCKED (basic salary kept)', () => {
    const access = buildModuleAccess('starter');

    expect(findModule(access, AppModule.LEAVE)?.enabled).toBe(true);
    expect(findModule(access, AppModule.REGULARIZATION)?.enabled).toBe(true);

    // Starter must get USABLE leave + regularization sub-features.
    expect(subFeatureAccess(access, AppModule.LEAVE, 'apply')).toBe(FeatureAccessLevel.FULL);
    expect(subFeatureAccess(access, AppModule.REGULARIZATION, 'request')).toBe(
      FeatureAccessLevel.FULL,
    );

    // Full Shifts at starter.
    expect(subFeatureAccess(access, AppModule.SHIFTS, 'create_shift')).toBe(
      FeatureAccessLevel.FULL,
    );

    // Salary stays BASIC at starter — no statutory payroll.
    expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.LOCKED,
    );
  });

  it('growth: full payroll statutory FULL; production modules (Manufacturing/Downtime) still OFF', () => {
    const access = buildModuleAccess('growth');

    expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.FULL,
    );
    expect(findModule(access, AppModule.MANUFACTURING)?.enabled).toBe(false);
    expect(findModule(access, AppModule.DOWNTIME)?.enabled).toBe(false);

    // Growth still has Leave + Regularization (cumulative from starter).
    expect(findModule(access, AppModule.LEAVE)?.enabled).toBe(true);
    expect(findModule(access, AppModule.REGULARIZATION)?.enabled).toBe(true);
  });

  it('business: production cluster ON — Manufacturing + Downtime + Maintenance enabled', () => {
    const access = buildModuleAccess('business');

    expect(findModule(access, AppModule.MANUFACTURING)?.enabled).toBe(true);
    expect(findModule(access, AppModule.DOWNTIME)?.enabled).toBe(true);
    expect(findModule(access, AppModule.MAINTENANCE)?.enabled).toBe(true);

    // Business is cumulative — growth payroll + starter leave still present.
    expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.FULL,
    );
    expect(findModule(access, AppModule.LEAVE)?.enabled).toBe(true);
  });

  it('custom: full access — production cluster + statutory all ON', () => {
    const access = buildModuleAccess('custom');

    expect(findModule(access, AppModule.MANUFACTURING)?.enabled).toBe(true);
    expect(findModule(access, AppModule.MAINTENANCE)?.enabled).toBe(true);
    expect(subFeatureAccess(access, AppModule.SALARY, 'statutory_compliance')).toBe(
      FeatureAccessLevel.FULL,
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2 — REGRESSION: tier-enum drift bug in repairMissingSubFeatures.
//
// The old tierToKey map downgraded growth -> 'starter' and business -> 'pro',
// so when the repair filled a MISSING sub-feature key on a growth/business
// subscription it pulled the LOWER tier's (locked) default instead of the
// subscription's own (full) entitlement — silently stripping paid features
// every boot. After the fix, growth resolves to its OWN growth defaults.
// ---------------------------------------------------------------------------

/**
 * Build a SubscriptionsService backed by mock models. We only exercise the
 * subscription branch of repairMissingSubFeatures, so only the subscription
 * model's find/updateOne chain has to behave.
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
  const noopAddOns: any = {};
  const noopSingleFlight: any = {};

  const service = new SubscriptionsService(
    planModel,
    subscriptionModel,
    noopModel,
    noopModel,
    noopModel,
    noopModel,
    noopAddOns,
    noopSingleFlight,
  );
  return { service, subscriptionModel };
}

describe('repairMissingSubFeatures — tier-enum drift regression', () => {
  it('fills a MISSING growth sub-feature from growth defaults (full), NOT downgraded starter (locked)', async () => {
    // A growth subscription whose SALARY module is MISSING the
    // statutory_compliance key (simulating a key added after seeding). The
    // repair must backfill it as FULL (growth default), not LOCKED (starter).
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

    expect(subscriptionModel.updateOne).toHaveBeenCalledTimes(1);
    const setArg = subscriptionModel.updateOne.mock.calls[0][1].$set;
    const patchedAccess: ModuleAccess = setArg['appliedEntitlements.moduleAccess'];

    const statutory = subFeatureAccess(patchedAccess, AppModule.SALARY, 'statutory_compliance');
    expect(statutory).toBe(FeatureAccessLevel.FULL); // growth default, not starter's LOCKED
  });

  it('growth subscription is NOT downgraded: a growth-only module (Downtime) keeps its growth entitlement when backfilled', async () => {
    // Growth enables DOWNTIME with full sub-features. A growth sub missing all
    // downtime keys must be backfilled from the growth tier (full), proving the
    // pass-through map resolves growth -> growth (the buggy map -> starter would
    // have produced an empty/locked block since starter has DOWNTIME locked).
    const growthSub: any = {
      _id: 'sub-growth-2',
      userId: 'user-2',
      planId: { tier: 'growth' },
      appliedEntitlements: {
        moduleAccess: [
          {
            module: AppModule.DOWNTIME,
            enabled: true,
            subFeatures: [], // all keys missing
          },
        ],
      },
    };

    const { service, subscriptionModel } = makeService([growthSub]);

    await service.repairMissingSubFeatures();

    const setArg = subscriptionModel.updateOne.mock.calls[0][1].$set;
    const patchedAccess: ModuleAccess = setArg['appliedEntitlements.moduleAccess'];

    expect(subFeatureAccess(patchedAccess, AppModule.DOWNTIME, 'log')).toBe(
      FeatureAccessLevel.FULL,
    );
  });
});
