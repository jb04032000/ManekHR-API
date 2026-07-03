/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase-1 ERP pricing rework — plan/tier entitlement RECONCILE migration.
 *
 * Real bug: the idempotent seed (`seed-default-tiers-and-plans.ts`) only INSERTS
 * (skip-if-exists) — it never CORRECTS an existing plan/tier. So a DB whose
 * Starter/Growth plan rows still carry a stale `maxMembersPerWorkspace:5` (the
 * Free-tier default) keeps showing "5 team members" on the pricing cards forever.
 * `ReconcileErpPlanEntitlementsService` force-reconciles the member-cap +
 * workspace + total-member + price fields back to the canonical source of truth,
 * ERP-only, and is safe to re-run (un-driftable).
 *
 * Contract asserted here:
 *   - A Starter plan stale at maxMembersPerWorkspace:5 -> updated to 25.
 *   - A Growth plan stale at 5 -> updated to 100.
 *   - A Business plan already at 500 -> still set to 500 (idempotent, no error).
 *   - Tiers are reconciled too (Starter tier defaultEntitlements cap -> 25).
 *   - Connect plans (product='connect') are NOT touched (excluded from the query).
 *   - Prices reconciled (Starter monthlyPrice -> 999, yearlyPrice -> 9999).
 *
 * Keep-in-sync: seed-default-tiers-and-plans.ts (TIER_DEFINITIONS / PLAN_DEFINITIONS)
 * + canonical-plan-seed.vitest.ts. The canonical numbers below MUST match those.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { Types } from 'mongoose';
import { ReconcileErpPlanEntitlementsService } from '../reconcile-erp-plan-entitlements.service';

/**
 * In-memory planModel mock. `find(filter)` matches the operators this migration
 * uses (tier equality, product $ne 'connect'). `updateOne($set)` mutates the
 * matched doc and reports a modifiedCount based on whether the $set was a no-op.
 */
function buildPlanModel(docs: any[]) {
  const matches = (doc: any, filter: any): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'product') {
        const pv = doc.product ?? 'erp';
        if (v && typeof v === 'object' && '$ne' in (v as any)) {
          if (pv === (v as any).$ne) return false;
        } else if (pv !== v) {
          return false;
        }
        continue;
      }
      if (doc[k] !== v) return false;
    }
    return true;
  };
  const model: any = {
    _docs: docs,
    find: vi.fn((filter: any = {}) => ({
      exec: vi.fn().mockResolvedValue(docs.filter((d) => matches(d, filter))),
    })),
    updateOne: vi.fn((filter: any, update: any) => {
      const target = docs.find((d) => matches(d, filter));
      let modified = 0;
      if (target && update.$set) {
        // Did any value actually change? (drives idempotent modifiedCount logging)
        for (const [path, val] of Object.entries(update.$set)) {
          const cur = path
            .split('.')
            .reduce((o: any, seg) => (o == null ? undefined : o[seg]), target);
          if (cur !== val) modified = 1;
        }
        // Apply the $set (supports dotted paths the service writes).
        for (const [path, val] of Object.entries(update.$set)) {
          const segs = path.split('.');
          let o: any = target;
          for (let i = 0; i < segs.length - 1; i++) {
            o[segs[i]] = o[segs[i]] ?? {};
            o = o[segs[i]];
          }
          o[segs[segs.length - 1]] = val;
        }
      }
      return { exec: vi.fn().mockResolvedValue({ modifiedCount: modified }) };
    }),
  };
  return model;
}

/** In-memory tierModel mock keyed by `key`, same updateOne semantics. */
function buildTierModel(docs: any[] = []) {
  const model: any = {
    _docs: docs,
    findOne: vi.fn((filter: any) => ({
      exec: vi.fn().mockResolvedValue(docs.find((d) => d.key === filter.key) ?? null),
    })),
    updateOne: vi.fn((filter: any, update: any) => {
      const target = docs.find((d) => d.key === filter.key);
      let modified = 0;
      if (target && update.$set) {
        for (const [path, val] of Object.entries(update.$set)) {
          const cur = path
            .split('.')
            .reduce((o: any, seg) => (o == null ? undefined : o[seg]), target);
          if (cur !== val) modified = 1;
        }
        for (const [path, val] of Object.entries(update.$set)) {
          const segs = path.split('.');
          let o: any = target;
          for (let i = 0; i < segs.length - 1; i++) {
            o[segs[i]] = o[segs[i]] ?? {};
            o = o[segs[i]];
          }
          o[segs[segs.length - 1]] = val;
        }
      }
      return { exec: vi.fn().mockResolvedValue({ modifiedCount: modified }) };
    }),
  };
  return model;
}

describe('ReconcileErpPlanEntitlementsService', () => {
  it('corrects a Starter plan stale at maxMembersPerWorkspace:5 -> 25 (assert the $set)', async () => {
    const id = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: id,
        name: 'Starter Monthly',
        tier: 'starter',
        product: 'erp',
        monthlyPrice: 999,
        yearlyPrice: 9999,
        entitlements: { maxMembersPerWorkspace: 5, maxWorkspaces: 1, maxTotalMembers: 5 },
      },
    ]);
    const svc = new ReconcileErpPlanEntitlementsService(planModel, buildTierModel());

    await svc.run();

    // The $set carried the canonical member cap.
    const setCalls = planModel.updateOne.mock.calls.filter(
      (c: any[]) => String(c[0]._id) === String(id),
    );
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    const $set = setCalls[0][1].$set;
    expect($set['entitlements.maxMembersPerWorkspace']).toBe(25);
    // And the doc reflects it.
    const row = planModel._docs.find((d: any) => d._id === id);
    expect(row.entitlements.maxMembersPerWorkspace).toBe(25);
  });

  it('corrects a Growth plan stale at 5 -> 100', async () => {
    const id = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: id,
        name: 'Growth Monthly',
        tier: 'growth',
        product: 'erp',
        monthlyPrice: 2499,
        yearlyPrice: 24999,
        entitlements: { maxMembersPerWorkspace: 5, maxWorkspaces: 1, maxTotalMembers: 5 },
      },
    ]);
    const svc = new ReconcileErpPlanEntitlementsService(planModel, buildTierModel());

    await svc.run();

    const row = planModel._docs.find((d: any) => d._id === id);
    expect(row.entitlements.maxMembersPerWorkspace).toBe(100);
    expect(row.entitlements.maxWorkspaces).toBe(2);
    expect(row.entitlements.maxTotalMembers).toBe(200);
  });

  it('is idempotent: a Business plan already at 500 stays 500 with no error', async () => {
    const id = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: id,
        name: 'Business Monthly',
        tier: 'business',
        product: 'erp',
        monthlyPrice: 4999,
        yearlyPrice: 49999,
        entitlements: { maxMembersPerWorkspace: 500, maxWorkspaces: 5, maxTotalMembers: 2500 },
      },
    ]);
    const svc = new ReconcileErpPlanEntitlementsService(planModel, buildTierModel());

    const result = await svc.run();

    const row = planModel._docs.find((d: any) => d._id === id);
    expect(row.entitlements.maxMembersPerWorkspace).toBe(500);
    expect(result).toBeDefined();
  });

  it('reconciles tiers too: Starter tier defaultEntitlements cap -> 25', async () => {
    const tierModel = buildTierModel([
      {
        key: 'starter',
        defaultEntitlements: { maxMembersPerWorkspace: 5, maxWorkspaces: 1, maxTotalMembers: 5 },
      },
    ]);
    const svc = new ReconcileErpPlanEntitlementsService(buildPlanModel([]), tierModel);

    await svc.run();

    const tier = tierModel._docs.find((t: any) => t.key === 'starter');
    expect(tier.defaultEntitlements.maxMembersPerWorkspace).toBe(25);
    expect(tier.defaultEntitlements.maxWorkspaces).toBe(1);
    expect(tier.defaultEntitlements.maxTotalMembers).toBe(25);
  });

  it('does NOT touch Connect plans (product=connect)', async () => {
    const connectId = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: connectId,
        name: 'Connect Starter',
        tier: 'starter',
        product: 'connect',
        monthlyPrice: 0,
        yearlyPrice: 0,
        entitlements: { maxMembersPerWorkspace: 5, maxWorkspaces: 1, maxTotalMembers: 5 },
      },
    ]);
    const svc = new ReconcileErpPlanEntitlementsService(planModel, buildTierModel());

    await svc.run();

    // The Connect plan must NOT have been updated.
    const touched = planModel.updateOne.mock.calls.some(
      (c: any[]) => String(c[0]._id) === String(connectId),
    );
    expect(touched).toBe(false);
    const row = planModel._docs.find((d: any) => d._id === connectId);
    expect(row.entitlements.maxMembersPerWorkspace).toBe(5); // untouched
  });

  it('reconciles prices: Starter monthlyPrice -> 999, yearlyPrice -> 9999 (price field in the $set)', async () => {
    const id = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: id,
        name: 'Starter Monthly',
        tier: 'starter',
        product: 'erp',
        monthlyPrice: 499, // stale legacy price
        yearlyPrice: 4999,
        entitlements: { maxMembersPerWorkspace: 25, maxWorkspaces: 1, maxTotalMembers: 25 },
      },
    ]);
    const svc = new ReconcileErpPlanEntitlementsService(planModel, buildTierModel());

    await svc.run();

    const setCalls = planModel.updateOne.mock.calls.filter(
      (c: any[]) => String(c[0]._id) === String(id),
    );
    const $set = setCalls[0][1].$set;
    // At least one price field present in the $set.
    expect('monthlyPrice' in $set || 'yearlyPrice' in $set).toBe(true);
    const row = planModel._docs.find((d: any) => d._id === id);
    expect(row.monthlyPrice).toBe(999);
    expect(row.yearlyPrice).toBe(9999);
  });
});
