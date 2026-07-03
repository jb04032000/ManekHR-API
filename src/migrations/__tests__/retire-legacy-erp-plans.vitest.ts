/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase-1 ERP pricing rework — legacy-plan retirement migration.
 *
 * Data-SAFETY contract for `RetireLegacyErpPlansService`:
 *   - Public Enterprise plan(s) (tier='enterprise') -> deactivated + hidden
 *     (NEVER deleted — existing subscriptions may still point at them).
 *   - Custom plan(s) (tier='custom') -> isPubliclyVisible:false + isCustom:true.
 *   - Legacy obsolete plans (tier='pro' OR the old hand-seed names) that have
 *     ZERO subscriptions -> deleted.
 *   - Legacy obsolete plans WITH >=1 subscription -> NOT deleted; deactivated +
 *     hidden + warned (the owner migrates those subs manually).
 *   - Idempotent: re-run over a clean set => no deletes, no throws.
 *
 * Connect plans (product='connect') are out of scope (ERP-only migration).
 *
 * Keep-in-sync: canonical-plan-seed.vitest.ts (the surviving 5-plan set).
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
import { RetireLegacyErpPlansService } from '../retire-legacy-erp-plans.service';

/**
 * Build a planModel mock backed by an in-memory array. `find(filter)` returns a
 * naive matcher supporting the few operators this migration uses
 * (tier equality, tier $in, name $in, product $ne). updateOne / deleteOne
 * mutate the backing array.
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
      if (v && typeof v === 'object' && '$in' in (v as any)) {
        if (!(v as any).$in.includes(doc[k])) return false;
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
      if (target && update.$set) Object.assign(target, update.$set);
      return { exec: vi.fn().mockResolvedValue({ modifiedCount: target ? 1 : 0 }) };
    }),
    deleteOne: vi.fn((filter: any) => {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx >= 0) docs.splice(idx, 1);
      return { exec: vi.fn().mockResolvedValue({ deletedCount: idx >= 0 ? 1 : 0 }) };
    }),
  };
  return model;
}

/** subscriptionModel.countDocuments({ planId }) -> count from the supplied map. */
function buildSubscriptionModel(countByPlanId: Record<string, number>) {
  return {
    countDocuments: vi.fn((filter: any) => {
      const id = String(filter.planId);
      return { exec: vi.fn().mockResolvedValue(countByPlanId[id] ?? 0) };
    }),
  };
}

function buildTierModel(tierDocs: any[] = []) {
  return {
    updateOne: vi.fn((filter: any, update: any) => {
      const target = tierDocs.find((d) => d.key === filter.key);
      if (target && update.$set) Object.assign(target, update.$set);
      return { exec: vi.fn().mockResolvedValue({ modifiedCount: target ? 1 : 0 }) };
    }),
    _docs: tierDocs,
  };
}

describe('RetireLegacyErpPlansService', () => {
  it('deactivates + hides the public Enterprise plan (never deletes it)', async () => {
    const entId = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: entId,
        name: 'Enterprise (Custom Quote)',
        tier: 'enterprise',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: true,
      },
    ]);
    const subModel = buildSubscriptionModel({ [String(entId)]: 3 });
    const tierModel = buildTierModel([{ key: 'enterprise', isActive: true }]);
    const svc = new RetireLegacyErpPlansService(planModel, subModel as any, tierModel as any);

    const result = await svc.run();

    // Enterprise row preserved (still in backing array), now inactive + hidden.
    expect(planModel.deleteOne).not.toHaveBeenCalled();
    const ent = planModel._docs.find((d: any) => d._id === entId);
    expect(ent).toBeDefined();
    expect(ent.isActive).toBe(false);
    expect(ent.isPubliclyVisible).toBe(false);
    expect(result.enterpriseRetired).toBeGreaterThanOrEqual(1);
    // Enterprise tier doc deactivated.
    expect(tierModel._docs.find((t: any) => t.key === 'enterprise').isActive).toBe(false);
  });

  it('flags the Custom plan: isPubliclyVisible:false + isCustom:true', async () => {
    const customId = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: customId,
        name: 'Custom Plan',
        tier: 'custom',
        product: 'erp',
        isPubliclyVisible: true,
        isCustom: false,
      },
    ]);
    const svc = new RetireLegacyErpPlansService(
      planModel,
      buildSubscriptionModel({}) as any,
      buildTierModel() as any,
    );

    await svc.run();

    const custom = planModel._docs.find((d: any) => d._id === customId);
    expect(custom.isPubliclyVisible).toBe(false);
    expect(custom.isCustom).toBe(true);
    expect(planModel.deleteOne).not.toHaveBeenCalled();
  });

  it("deletes a legacy 'pro' plan that has ZERO subscriptions", async () => {
    const proId = new Types.ObjectId();
    const planModel = buildPlanModel([
      { _id: proId, name: 'Pro Starter', tier: 'pro', product: 'erp' },
    ]);
    const subModel = buildSubscriptionModel({ [String(proId)]: 0 });
    const svc = new RetireLegacyErpPlansService(
      planModel,
      subModel as any,
      buildTierModel() as any,
    );

    const result = await svc.run();

    expect(planModel.deleteOne).toHaveBeenCalled();
    // Row actually removed from the backing store.
    expect(planModel._docs.find((d: any) => d._id === proId)).toBeUndefined();
    expect(result.legacyDeleted).toBeGreaterThanOrEqual(1);
  });

  it('CRITICAL DATA-SAFETY: a legacy plan WITH subscriptions is NOT deleted, only deactivated + hidden', async () => {
    const legacyId = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: legacyId,
        name: 'Free Forever',
        tier: 'free',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: true,
      },
    ]);
    const subModel = buildSubscriptionModel({ [String(legacyId)]: 1 });
    const svc = new RetireLegacyErpPlansService(
      planModel,
      subModel as any,
      buildTierModel() as any,
    );

    const result = await svc.run();

    // NEVER deleted while a sub references it.
    expect(planModel.deleteOne).not.toHaveBeenCalled();
    const legacy = planModel._docs.find((d: any) => d._id === legacyId);
    expect(legacy).toBeDefined();
    expect(legacy.isActive).toBe(false);
    expect(legacy.isPubliclyVisible).toBe(false);
    expect(result.legacyDeactivatedWithSubs).toBeGreaterThanOrEqual(1);
    expect(result.legacyDeleted).toBe(0);
  });

  it('idempotent: a second run over an already-clean canonical set performs no deletes and throws nothing', async () => {
    // Canonical post-migration state: 4 self-serve plans + a flagged Custom.
    const planModel = buildPlanModel([
      {
        _id: new Types.ObjectId(),
        name: 'Free Plan',
        tier: 'free',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: true,
        isCustom: false,
      },
      {
        _id: new Types.ObjectId(),
        name: 'Starter Monthly',
        tier: 'starter',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: true,
        isCustom: false,
      },
      {
        _id: new Types.ObjectId(),
        name: 'Growth Monthly',
        tier: 'growth',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: true,
        isCustom: false,
      },
      {
        _id: new Types.ObjectId(),
        name: 'Business Monthly',
        tier: 'business',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: true,
        isCustom: false,
      },
      {
        _id: new Types.ObjectId(),
        name: 'Custom Plan',
        tier: 'custom',
        product: 'erp',
        isActive: true,
        isPubliclyVisible: false,
        isCustom: true,
      },
    ]);
    const subModel = buildSubscriptionModel({});
    const svc = new RetireLegacyErpPlansService(
      planModel,
      subModel as any,
      buildTierModel() as any,
    );

    const first = await svc.run();
    const second = await svc.run();

    expect(planModel.deleteOne).not.toHaveBeenCalled();
    expect(second.legacyDeleted).toBe(0);
    expect(second.enterpriseRetired).toBe(0);
    // Backing set unchanged (5 plans remain).
    expect(planModel._docs.length).toBe(5);
    // The Custom plan stayed flagged across both runs.
    const custom = planModel._docs.find((d: any) => d.tier === 'custom');
    expect(custom.isPubliclyVisible).toBe(false);
    expect(custom.isCustom).toBe(true);
    expect(first).toBeDefined();
  });

  it('ignores Connect plans (product=connect) entirely', async () => {
    const connectEntId = new Types.ObjectId();
    const planModel = buildPlanModel([
      {
        _id: connectEntId,
        name: 'Connect Enterprise',
        tier: 'enterprise',
        product: 'connect',
        isActive: true,
        isPubliclyVisible: true,
      },
    ]);
    const svc = new RetireLegacyErpPlansService(
      planModel,
      buildSubscriptionModel({}) as any,
      buildTierModel() as any,
    );

    const result = await svc.run();

    // Untouched — still active/visible.
    const row = planModel._docs.find((d: any) => d._id === connectEntId);
    expect(row.isActive).toBe(true);
    expect(row.isPubliclyVisible).toBe(true);
    expect(result.enterpriseRetired).toBe(0);
  });
});
