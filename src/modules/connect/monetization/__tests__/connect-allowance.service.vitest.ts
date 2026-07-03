/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive decorated schema imports (Subscription, Plan) do not trip
// vitest's reflect-metadata pipeline. Models are injected as plain mocks.
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

// Mutable holder for the CONNECT_LIMITS_ENFORCED flag so a single test can flip
// it on/off. The env mock reads it via a getter, so the service's call-time read
// picks up the current value. Default true mirrors the production default.
const flagState = vi.hoisted(() => ({ enforced: true }));
vi.mock('../../../../config/env', () => ({
  env: {
    connectLimits: {
      get enforced() {
        return flagState.enforced;
      },
    },
  },
}));

import { Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import {
  ConnectAllowanceService,
  ConnectLimitReachedException,
  CONNECT_FREE_DEFAULT_ALLOWANCES,
} from '../connect-allowance.service';

/**
 * M0.5 - ConnectAllowanceService.
 *
 * Verifies person-centric allowance resolution + cap enforcement:
 *   - active Connect sub -> its appliedEntitlements.connect,
 *   - entitlementsOverride.connect wins per-field over the snapshot,
 *   - no sub -> connect_free plan fallback,
 *   - no sub + no free plan -> safe built-in default,
 *   - assertCanCreateListing throws at the cap, passes under it, never for -1,
 *   - canUseLead is false at the cap, true under it, true for -1.
 */
const userId = new Types.ObjectId().toString();

// findOne(...).lean().exec() -> result
const findOneChain = (result: any) => ({
  lean: () => ({ exec: () => Promise.resolve(result) }),
});

const makeSubModel = (sub: any) => ({ findOne: vi.fn(() => findOneChain(sub)) });
const makePlanModel = (plan: any) => ({ findOne: vi.fn(() => findOneChain(plan)) });

const build = (sub: any, plan: any) =>
  new ConnectAllowanceService(makeSubModel(sub) as any, makePlanModel(plan) as any);

describe('ConnectAllowanceService (M0.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagState.enforced = true; // default each test to enforcement ON
  });

  it('returns the active Connect subscription connect sub-block', async () => {
    const svc = build(
      {
        appliedEntitlements: {
          connect: {
            maxListings: -1,
            leadsPerMonth: -1,
            includedBoostCredits: 500,
            verifiedBadge: true,
            searchPriority: 10,
          },
        },
      },
      null,
    );

    const allowances = await svc.getAllowances(userId);

    expect(allowances).toEqual({
      maxListings: -1,
      leadsPerMonth: -1,
      includedBoostCredits: 500,
      verifiedBadge: true,
      searchPriority: 10,
      // not set in the snapshot -> normalized from the free default
      maxCompanyPages: 1,
      maxStorefronts: 1,
      maxJobs: 10,
      storageMb: 500,
    });
  });

  it('applies entitlementsOverride.connect per-field over the snapshot', async () => {
    const svc = build(
      {
        appliedEntitlements: { connect: { ...CONNECT_FREE_DEFAULT_ALLOWANCES } },
        entitlementsOverride: { connect: { maxListings: 100, verifiedBadge: true } },
      },
      null,
    );

    const allowances = await svc.getAllowances(userId);

    expect(allowances.maxListings).toBe(100); // override wins
    expect(allowances.verifiedBadge).toBe(true); // override wins
    expect(allowances.leadsPerMonth).toBe(-1); // snapshot retained
  });

  it('falls back to the connect_free plan when no active Connect subscription', async () => {
    const svc = build(null, {
      entitlements: {
        connect: { maxListings: 25, leadsPerMonth: -1, searchPriority: 0 },
      },
    });

    const allowances = await svc.getAllowances(userId);

    expect(allowances.maxListings).toBe(25);
    expect(allowances.leadsPerMonth).toBe(-1);
    expect(allowances.verifiedBadge).toBe(false); // normalized default
  });

  it('falls back to the safe built-in default when no sub and no free plan', async () => {
    const svc = build(null, null);

    const allowances = await svc.getAllowances(userId);

    expect(allowances).toEqual(CONNECT_FREE_DEFAULT_ALLOWANCES);
  });

  it('assertCanCreateListing throws at the cap and passes under it', async () => {
    const svc = build({ appliedEntitlements: { connect: { maxListings: 3 } } }, null);

    await expect(svc.assertCanCreateListing(userId, 3)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assertCanCreateListing(userId, 2)).resolves.toBeUndefined();
  });

  it('assertCanCreateListing never throws when listings are unlimited (-1)', async () => {
    const svc = build({ appliedEntitlements: { connect: { maxListings: -1 } } }, null);

    await expect(svc.assertCanCreateListing(userId, 9999)).resolves.toBeUndefined();
  });

  it('assertCanCreateCompanyPage throws at the cap and passes under it', async () => {
    const svc = build({ appliedEntitlements: { connect: { maxCompanyPages: 1 } } }, null);

    await expect(svc.assertCanCreateCompanyPage(userId, 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.assertCanCreateCompanyPage(userId, 0)).resolves.toBeUndefined();
  });

  it('assertCanCreateStorefront throws at the cap, unlimited (-1) never throws', async () => {
    const capped = build({ appliedEntitlements: { connect: { maxStorefronts: 2 } } }, null);
    await expect(capped.assertCanCreateStorefront(userId, 2)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(capped.assertCanCreateStorefront(userId, 1)).resolves.toBeUndefined();

    const unlimited = build({ appliedEntitlements: { connect: { maxStorefronts: -1 } } }, null);
    await expect(unlimited.assertCanCreateStorefront(userId, 9999)).resolves.toBeUndefined();
  });

  it('canUseLead reflects the per-cycle cap (and unlimited)', async () => {
    const capped = build({ appliedEntitlements: { connect: { leadsPerMonth: 10 } } }, null);
    expect(await capped.canUseLead(userId, 9)).toBe(true);
    expect(await capped.canUseLead(userId, 10)).toBe(false);

    const unlimited = build({ appliedEntitlements: { connect: { leadsPerMonth: -1 } } }, null);
    expect(await unlimited.canUseLead(userId, 999999)).toBe(true);
  });

  // --- CONNECT_LIMITS_ENFORCED flag + typed error shape (limit-enforcement step) ---

  it('flag OFF: every assert is a no-op even far over the cap', async () => {
    flagState.enforced = false;
    const svc = build(
      {
        appliedEntitlements: {
          connect: { maxListings: 1, maxStorefronts: 1, maxCompanyPages: 1, maxJobs: 1 },
        },
      },
      null,
    );

    await expect(svc.assertCanCreateListing(userId, 9999)).resolves.toBeUndefined();
    await expect(svc.assertCanCreateStorefront(userId, 9999)).resolves.toBeUndefined();
    await expect(svc.assertCanCreateCompanyPage(userId, 9999)).resolves.toBeUndefined();
    await expect(svc.assertCanCreateJob(userId, 9999)).resolves.toBeUndefined();
  });

  it('flag ON: rejects at the cap with the consistent typed body { code, kind, limit, used }', async () => {
    const svc = build(
      {
        appliedEntitlements: {
          connect: { maxListings: 20, maxStorefronts: 1, maxCompanyPages: 1, maxJobs: 10 },
        },
      },
      null,
    );

    const cases: Array<[() => Promise<void>, string, number, number]> = [
      [() => svc.assertCanCreateListing(userId, 20), 'listing', 20, 20],
      [() => svc.assertCanCreateStorefront(userId, 1), 'storefront', 1, 1],
      [() => svc.assertCanCreateCompanyPage(userId, 1), 'company_page', 1, 1],
      [() => svc.assertCanCreateJob(userId, 10), 'job', 10, 10],
    ];

    for (const [call, kind, limit, used] of cases) {
      let thrown: ForbiddenException | undefined;
      try {
        await call();
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ConnectLimitReachedException);
      expect(thrown.getStatus()).toBe(403);
      expect(thrown.getResponse()).toMatchObject({
        code: 'CONNECT_LIMIT_REACHED',
        kind,
        limit,
        used,
      });
    }
  });

  it('flag ON: unlimited (-1) still never throws regardless of count', async () => {
    const svc = build({ appliedEntitlements: { connect: { maxListings: -1, maxJobs: -1 } } }, null);
    await expect(svc.assertCanCreateListing(userId, 100000)).resolves.toBeUndefined();
    await expect(svc.assertCanCreateJob(userId, 100000)).resolves.toBeUndefined();
  });

  it('flag ON: entitlementsOverride raises the effective cap for the assert', async () => {
    const svc = build(
      {
        appliedEntitlements: { connect: { maxListings: 25 } },
        entitlementsOverride: { connect: { maxListings: 100 } },
      },
      null,
    );
    // 30 is over the snapshot 25 but under the override 100 -> allowed.
    await expect(svc.assertCanCreateListing(userId, 30)).resolves.toBeUndefined();
    // 100 hits the overridden cap -> rejected.
    await expect(svc.assertCanCreateListing(userId, 100)).rejects.toBeInstanceOf(
      ConnectLimitReachedException,
    );
  });
});
