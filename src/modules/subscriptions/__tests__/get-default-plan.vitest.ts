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
// @nestjs/schedule's @Cron decorator is applied at class-eval time on the service.
vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { SubscriptionsService } from '../subscriptions.service';

/**
 * Phase-2 ERP pricing rework — getDefaultPlanId resolves the plan a new sign-up
 * is auto-assigned. Fallback chain: isDefault plan -> active free plan -> null.
 * The free fallback is CRITICAL for existing DBs that have no isDefault plan yet.
 */
const buildSvc = (planModel: any) => {
  const svc = new SubscriptionsService(
    planModel, // planModel
    {} as any, // subscriptionModel
    {} as any, // appSettingsModel
    {} as any, // tierModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    {} as any, // addOnsService
    {} as any, // singleFlight
  );
  return svc;
};

/** A planModel.findOne(query) -> { exec } stub driven by a query->row resolver. */
const makePlanModel = (resolve: (query: any) => any) => ({
  findOne: vi.fn((query: any) => ({ exec: vi.fn().mockResolvedValue(resolve(query)) })),
});

describe('SubscriptionsService.getDefaultPlanId (Phase 2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the active isDefault plan id when one exists', async () => {
    const planModel = makePlanModel((q) => (q.isDefault === true ? { _id: 'default-plan' } : null));
    const svc = buildSvc(planModel as any);

    const id = await svc.getDefaultPlanId('erp');
    expect(id).toBe('default-plan');
    // Queried isDefault + isActive + product.
    expect(planModel.findOne).toHaveBeenCalledWith({
      isDefault: true,
      isActive: true,
      product: 'erp',
    });
  });

  it('falls back to the active free plan when no isDefault plan exists', async () => {
    const planModel = makePlanModel((q) => (q.tier === 'free' ? { _id: 'free-plan' } : null));
    const svc = buildSvc(planModel as any);

    const id = await svc.getDefaultPlanId('erp');
    expect(id).toBe('free-plan');
    expect(planModel.findOne).toHaveBeenCalledWith({
      tier: 'free',
      isActive: true,
      product: 'erp',
    });
  });

  it('returns null when neither an isDefault nor a free plan exists', async () => {
    const planModel = makePlanModel(() => null);
    const svc = buildSvc(planModel as any);

    const id = await svc.getDefaultPlanId('erp');
    expect(id).toBeNull();
  });

  it('defaults the product arg to erp', async () => {
    const planModel = makePlanModel((q) => (q.isDefault === true ? { _id: 'd' } : null));
    const svc = buildSvc(planModel as any);

    await svc.getDefaultPlanId();
    expect(planModel.findOne).toHaveBeenCalledWith({
      isDefault: true,
      isActive: true,
      product: 'erp',
    });
  });
});
