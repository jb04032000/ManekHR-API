/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose so the transitive decorated Subscription schema import
// does not trip vitest's reflect-metadata pipeline. The model is a plain mock.
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

import { BackfillConnectSubFeatureKeysService } from '../backfill-connect-subfeature-keys';
import { AppModule } from '../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../common/enums/feature-access.enum';

/**
 * RISK #3 (deferred from M0.8, run with the first guarded Connect endpoint in
 * M1.2): back-fill the four Connect sub-feature keys onto active/trial
 * product:'connect' subscriptions whose entitlement snapshot predates them, so
 * the fail-closed guard never reads an ABSENT key as LOCKED. Idempotent.
 */
const CONNECT_KEYS = [
  'marketplace.listings',
  'marketplace.leads',
  'profile.verified_badge',
  'search.priority',
];

const build = (subs: any[]) => {
  const subscriptionModel = {
    find: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve(subs) }) })),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const svc = new BackfillConnectSubFeatureKeysService(subscriptionModel as any);
  return { svc, subscriptionModel };
};

/** Pull the CONNECT module entry out of an updateOne $set payload. */
function connectEntryFromSet(setArg: any) {
  const moduleAccess = setArg.$set['appliedEntitlements.moduleAccess'];
  return moduleAccess.find((m: any) => m.module === AppModule.CONNECT);
}

describe('BackfillConnectSubFeatureKeysService (RISK #3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries only active/trial connect subscriptions', async () => {
    const { svc, subscriptionModel } = build([]);
    await svc.run();
    const filter = subscriptionModel.find.mock.calls[0][0];
    expect(filter.product).toBe('connect');
    expect(filter.status.$in).toEqual(expect.arrayContaining(['active', 'trial']));
  });

  it('adds a full CONNECT entry when moduleAccess has none', async () => {
    const { svc, subscriptionModel } = build([
      { _id: 'a', appliedEntitlements: { moduleAccess: [] } },
    ]);

    const result = await svc.run();

    expect(subscriptionModel.updateOne).toHaveBeenCalledOnce();
    const [filter, update] = subscriptionModel.updateOne.mock.calls[0];
    expect(filter._id).toBe('a');
    const entry = connectEntryFromSet(update);
    expect(entry).toBeDefined();
    expect(entry.enabled).toBe(true);
    expect(entry.subFeatures.map((s: any) => s.key).sort()).toEqual([...CONNECT_KEYS].sort());
    expect(result.subscriptionsUpdated).toBe(1);
  });

  it('handles a missing appliedEntitlements object entirely', async () => {
    const { svc, subscriptionModel } = build([{ _id: 'a' }]);
    await svc.run();
    expect(subscriptionModel.updateOne).toHaveBeenCalledOnce();
    const entry = connectEntryFromSet(subscriptionModel.updateOne.mock.calls[0][1]);
    expect(entry.subFeatures).toHaveLength(4);
  });

  it('is a no-op when all four keys already exist', async () => {
    const { svc, subscriptionModel } = build([
      {
        _id: 'b',
        appliedEntitlements: {
          moduleAccess: [
            {
              module: AppModule.CONNECT,
              enabled: true,
              subFeatures: CONNECT_KEYS.map((key) => ({ key, access: FeatureAccessLevel.FULL })),
            },
          ],
        },
      },
    ]);

    const result = await svc.run();

    expect(subscriptionModel.updateOne).not.toHaveBeenCalled();
    expect(result.subscriptionsUpdated).toBe(0);
  });

  it('appends only the missing keys and preserves existing access levels', async () => {
    const { svc, subscriptionModel } = build([
      {
        _id: 'c',
        appliedEntitlements: {
          moduleAccess: [
            {
              module: AppModule.CONNECT,
              enabled: true,
              // verified_badge intentionally premium (FULL) here; backfill must NOT downgrade it.
              subFeatures: [
                { key: 'marketplace.listings', access: FeatureAccessLevel.FULL },
                { key: 'profile.verified_badge', access: FeatureAccessLevel.FULL },
              ],
            },
          ],
        },
      },
    ]);

    await svc.run();

    const entry = connectEntryFromSet(subscriptionModel.updateOne.mock.calls[0][1]);
    expect(entry.subFeatures.map((s: any) => s.key).sort()).toEqual([...CONNECT_KEYS].sort());
    const badge = entry.subFeatures.find((s: any) => s.key === 'profile.verified_badge');
    expect(badge.access).toBe(FeatureAccessLevel.FULL); // preserved, not reset to LOCKED
  });

  it('preserves unrelated module entries', async () => {
    const { svc, subscriptionModel } = build([
      {
        _id: 'd',
        appliedEntitlements: {
          moduleAccess: [{ module: 'attendance', enabled: true, subFeatures: [] }],
        },
      },
    ]);

    await svc.run();

    const moduleAccess =
      subscriptionModel.updateOne.mock.calls[0][1].$set['appliedEntitlements.moduleAccess'];
    expect(moduleAccess.find((m: any) => m.module === 'attendance')).toBeDefined();
    expect(moduleAccess.find((m: any) => m.module === AppModule.CONNECT)).toBeDefined();
  });
});
