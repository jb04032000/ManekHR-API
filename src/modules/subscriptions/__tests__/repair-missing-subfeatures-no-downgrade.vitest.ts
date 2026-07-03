/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing SubscriptionsService so the
// transitive schema imports (Plan/Subscription/Workspace/etc.) don't trip the
// reflect-metadata "Cannot determine type" error under vitest's esbuild
// transform. All Models are injected as plain mocks below.
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

import { Types } from 'mongoose';
import { SubscriptionsService } from '../subscriptions.service';
import { buildModuleAccess } from '../../../common/constants/module-features.registry';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';

/**
 * Regression for the tier-enum drift bug: repairMissingSubFeatures() used to map
 * growth -> 'starter' and business -> 'pro' in its tierToKey table, so the
 * bootstrap repair pass SILENTLY downgraded paid subscriptions' entitlements
 * (e.g. stripping statutory payroll from Growth subs). The map now passes the
 * tier through unchanged.
 *
 * This test feeds a Growth subscription whose appliedEntitlements.moduleAccess
 * is the correct growth set minus one sub-feature key (to trigger the
 * fill-in-missing-keys path) and asserts that after repair the moduleAccess
 * still reflects GROWTH defaults — LEAVE enabled + SALARY statutory_compliance
 * FULL — i.e. it was NOT rebuilt from the downgraded starter defaults (which
 * disable LEAVE and lock statutory_compliance).
 */
describe('SubscriptionsService.repairMissingSubFeatures — no silent tier downgrade', () => {
  let planModel: any;
  let subscriptionModel: any;
  let updatedAccess: any[] | undefined;

  // Chainable query stub helper: .find(...).lean() / .find(...).populate(...).lean()
  const leanResult = (rows: any[]) => ({ lean: () => Promise.resolve(rows) });
  const populateLeanResult = (rows: any[]) => ({
    populate: () => ({ lean: () => Promise.resolve(rows) }),
  });

  beforeEach(() => {
    updatedAccess = undefined;

    // Growth module access minus the SALARY `statutory_compliance` key so
    // repairMissingSubFeatures detects it as MISSING and RE-ADDS it from the
    // tier-resolved defaults. This is the decisive case: the re-added value
    // comes from buildModuleAccess(tierKey) — FULL if the tier resolves to
    // growth (correct), LOCKED if it was silently downgraded to starter (bug).
    // (repairMissingSubFeatures only fills MISSING keys; it never overwrites an
    // existing access level — so the dropped key must be the one we assert on.)
    const growthAccess = buildModuleAccess('growth').map((m) => {
      if (m.module === AppModule.SALARY) {
        return {
          ...m,
          subFeatures: m.subFeatures.filter((sf) => sf.key !== 'statutory_compliance'),
        };
      }
      return m;
    });

    const growthSub = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      status: 'active',
      planId: { tier: 'growth' },
      appliedEntitlements: { moduleAccess: growthAccess },
    };

    planModel = {
      // No plans to repair — return empty for the plans query.
      find: vi.fn(() => leanResult([])),
    };

    subscriptionModel = {
      find: vi.fn(() => populateLeanResult([growthSub])),
      updateOne: vi.fn((_filter: any, update: any) => {
        updatedAccess = update?.$set?.['appliedEntitlements.moduleAccess'];
        return Promise.resolve({ acknowledged: true });
      }),
    };
    // Only these two models are touched by repairMissingSubFeatures; the rest of
    // the constructor deps are passed as empty stubs in the test body.
  });

  it('repairs a Growth sub against GROWTH defaults (LEAVE on, statutory FULL), not downgraded starter', async () => {
    const svc = new SubscriptionsService(
      planModel,
      subscriptionModel,
      {} as any, // appSettingsModel — unused here
      {} as any, // tierModel — unused
      {} as any, // workspaceModel — unused
      {} as any, // workspaceMemberModel — unused
      {} as any, // addOnsService — unused
      {} as any, // singleFlight — unused
    );

    const result = await svc.repairMissingSubFeatures();

    // The dropped SALARY key was detected + re-added, so the sub was patched.
    expect(result.subscriptionsFixed).toBe(1);
    expect(updatedAccess).toBeDefined();

    const findModule = (mod: AppModule) => updatedAccess.find((m) => m.module === mod);

    // LEAVE stays enabled — growth has it; the downgraded 'starter' target would
    // also enable it, so the decisive signal is the statutory sub-feature below.
    expect(findModule(AppModule.LEAVE)?.enabled).toBe(true);

    // The decisive anti-downgrade assertion: growth SALARY has
    // statutory_compliance === FULL; starter SALARY locks it. If tierToKey had
    // downgraded growth -> starter, the re-added key would be LOCKED.
    const salaryStatutory = findModule(AppModule.SALARY)?.subFeatures?.find(
      (sf: any) => sf.key === 'statutory_compliance',
    );
    expect(salaryStatutory?.access).toBe(FeatureAccessLevel.FULL);

    // Sanity: buildModuleAccess('starter') WOULD have locked it — proves the
    // assertion above is meaningful (target was growth, not starter).
    const starterStatutory = buildModuleAccess('starter')
      .find((m) => m.module === AppModule.SALARY)
      ?.subFeatures.find((sf) => sf.key === 'statutory_compliance');
    expect(starterStatutory?.access).toBe(FeatureAccessLevel.LOCKED);
  });
});
