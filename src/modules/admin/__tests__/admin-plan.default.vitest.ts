/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing AdminService so transitive
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
vi.mock('../../subscriptions/subscriptions.service', () => ({ SubscriptionsService: class {} }));
vi.mock('../../add-ons/add-ons.service', () => ({ AddOnsService: class {} }));
vi.mock('../../audit/audit.service', () => ({ AuditService: class {} }));

import { AdminService } from '../admin.service';

/**
 * Phase-2 ERP pricing rework — exactly ONE default plan per product.
 *
 * Setting `isDefault:true` on a created/updated plan must atomically clear
 * `isDefault` on every OTHER plan of the SAME product. Scoped to product so a
 * future Connect default stays independent from the ERP default.
 */
const makePlanCtor = (savedProduct = 'erp', savedId = 'newId') => {
  // `new this.planModel(dto)` -> instance with save() returning a doc carrying
  // _id + product (mirrors what Mongoose persists, defaults applied).
  const ctor: any = vi.fn().mockImplementation((dto: any) => ({
    ...dto,
    save: vi.fn().mockResolvedValue({ ...dto, _id: savedId, product: dto.product ?? savedProduct }),
  }));
  ctor.updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
  ctor.findByIdAndUpdate = vi.fn();
  return ctor;
};

const build = (planModel: any) => {
  const subModel = { countDocuments: vi.fn().mockResolvedValue(0) };
  const svc = new AdminService(
    {} as any, // userModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    subModel as any, // subscriptionModel
    planModel, // planModel
    {} as any, // appSettingsModel
    {} as any, // tierModel
    {} as any, // ptSlabConfigModel
    {} as any, // subscriptionsService
    {} as any, // addOnsService
    {} as any, // auditService
  );
  return { svc, planModel };
};

describe('AdminService single-default plan enforcement (Phase 2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createPlan with isDefault:true clears isDefault on OTHER same-product plans', async () => {
    const planModel = makePlanCtor('erp', 'erp-new');
    const { svc } = build(planModel);

    await svc.createPlan({ name: 'X', tier: 'free', isDefault: true } as any);

    expect(planModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = planModel.updateMany.mock.calls[0];
    expect(filter._id).toEqual({ $ne: 'erp-new' });
    expect(filter.product).toBe('erp');
    expect(filter.isDefault).toBe(true);
    expect(update).toEqual({ $set: { isDefault: false } });
  });

  it('createPlan without isDefault does NOT touch other plans', async () => {
    const planModel = makePlanCtor();
    const { svc } = build(planModel);

    await svc.createPlan({ name: 'X', tier: 'free' } as any);

    expect(planModel.updateMany).not.toHaveBeenCalled();
  });

  it('updatePlan with isDefault:true clears isDefault on OTHER same-product plans', async () => {
    const planModel = makePlanCtor();
    // updatePlan uses findByIdAndUpdate(...).lean()
    planModel.findByIdAndUpdate = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'updId', product: 'connect', entitlements: {} }),
    });
    const { svc } = build(planModel);

    await svc.updatePlan('updId', { isDefault: true } as any);

    expect(planModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = planModel.updateMany.mock.calls[0];
    expect(filter._id).toEqual({ $ne: 'updId' });
    expect(filter.product).toBe('connect'); // scoped to the plan's own product
    expect(filter.isDefault).toBe(true);
    expect(update).toEqual({ $set: { isDefault: false } });
  });

  it('updatePlan without isDefault does NOT clear other plans', async () => {
    const planModel = makePlanCtor();
    planModel.findByIdAndUpdate = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'updId', product: 'erp', entitlements: {} }),
    });
    const { svc } = build(planModel);

    await svc.updatePlan('updId', { monthlyPrice: 100 } as any);

    expect(planModel.updateMany).not.toHaveBeenCalled();
  });
});
