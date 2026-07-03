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
 * Admin-configurable Trial Plan — exactly ONE trial plan per product.
 *
 * Setting `isTrialPlan:true` on a created/updated plan must atomically clear
 * `isTrialPlan` on every OTHER plan of the SAME product (mirrors the
 * single-default enforcement). A trial plan is a system plan, not buyable, so
 * it is ALSO forced `isPubliclyVisible:false` on the saved doc.
 */
const makePlanCtor = (savedProduct = 'erp', savedId = 'newId') => {
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

describe('AdminService single-trial-plan enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createPlan with isTrialPlan:true clears isTrialPlan on OTHER same-product plans', async () => {
    const planModel = makePlanCtor('erp', 'erp-new');
    const { svc } = build(planModel);

    await svc.createPlan({ name: 'Trial', tier: 'growth', isTrialPlan: true } as any);

    expect(planModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = planModel.updateMany.mock.calls[0];
    expect(filter._id).toEqual({ $ne: 'erp-new' });
    expect(filter.product).toBe('erp');
    expect(filter.isTrialPlan).toBe(true);
    expect(update).toEqual({ $set: { isTrialPlan: false } });
  });

  it('createPlan forces isPubliclyVisible:false on a trial plan (system plan, not buyable)', async () => {
    const planModel = makePlanCtor('erp', 'erp-new');
    const { svc } = build(planModel);

    // Even if the caller passes isPubliclyVisible:true, the saved doc is forced false.
    await svc.createPlan({
      name: 'Trial',
      tier: 'growth',
      isTrialPlan: true,
      isPubliclyVisible: true,
    } as any);

    // createPlan forces isPubliclyVisible:false on the constructed instance
    // (server-side, after `new this.planModel(dto)`), then saves it.
    const instance = planModel.mock.results[0].value;
    expect(instance.isPubliclyVisible).toBe(false);
  });

  it('createPlan without isTrialPlan does NOT touch other plans', async () => {
    const planModel = makePlanCtor();
    const { svc } = build(planModel);

    await svc.createPlan({ name: 'X', tier: 'free' } as any);

    expect(planModel.updateMany).not.toHaveBeenCalled();
  });

  it('updatePlan with isTrialPlan:true clears isTrialPlan on OTHER same-product plans + forces invisible', async () => {
    const planModel = makePlanCtor();
    planModel.findByIdAndUpdate = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'updId', product: 'erp', entitlements: {} }),
    });
    const { svc } = build(planModel);

    await svc.updatePlan('updId', { isTrialPlan: true } as any);

    // $set passed to findByIdAndUpdate must force isPubliclyVisible:false.
    const [, updateArg] = planModel.findByIdAndUpdate.mock.calls[0];
    expect(updateArg.$set.isPubliclyVisible).toBe(false);
    expect(updateArg.$set.isTrialPlan).toBe(true);

    // And it clears the flag on other same-product plans.
    const trialClear = planModel.updateMany.mock.calls.find(
      (c: any) => c[1]?.$set?.isTrialPlan === false,
    );
    expect(trialClear).toBeDefined();
    expect(trialClear[0].product).toBe('erp');
    expect(trialClear[0]._id).toEqual({ $ne: 'updId' });
  });

  it('updatePlan without isTrialPlan does NOT clear other plans for the trial flag', async () => {
    const planModel = makePlanCtor();
    planModel.findByIdAndUpdate = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'updId', product: 'erp', entitlements: {} }),
    });
    const { svc } = build(planModel);

    await svc.updatePlan('updId', { monthlyPrice: 100 } as any);

    const trialClear = planModel.updateMany.mock.calls.find(
      (c: any) => c[1]?.$set?.isTrialPlan === false,
    );
    expect(trialClear).toBeUndefined();
  });
});
