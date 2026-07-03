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
// Stub the heavy injected services so importing AdminService does not pull their
// dependency graphs into the unit context (they are mocked at construction).
vi.mock('../../subscriptions/subscriptions.service', () => ({ SubscriptionsService: class {} }));
vi.mock('../../add-ons/add-ons.service', () => ({ AddOnsService: class {} }));
vi.mock('../../audit/audit.service', () => ({ AuditService: class {} }));

import { AdminService } from '../admin.service';

/**
 * M0.7 - admin catalogue plan/tier management, Connect product axis.
 *
 * Verifies the admin plan/tier list endpoints filter by product line, and that
 * a created Connect plan carries its product + connect allowance block through
 * to persistence. Schemas already declare `product` (M0.1 plan / M0.4 tier); the
 * DTOs gain `product` + a connect entitlements sub-block in M0.7.
 */
const makePlanModel = (rows: any[]) => {
  const ctor: any = vi.fn().mockImplementation((dto: any) => ({
    ...dto,
    save: vi.fn().mockResolvedValue(dto),
  }));
  ctor.find = vi.fn(() => ({ lean: () => Promise.resolve(rows) }));
  return ctor;
};
const makeTierModel = (rows: any[]) => ({
  find: vi.fn(() => ({ sort: () => ({ lean: () => Promise.resolve(rows) }) })),
});

const build = (planRows: any[] = [], tierRows: any[] = []) => {
  const planModel = makePlanModel(planRows);
  const tierModel = makeTierModel(tierRows);
  const subModel = { countDocuments: vi.fn().mockResolvedValue(0) };
  const svc = new AdminService(
    {} as any, // userModel
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    subModel as any, // subscriptionModel
    planModel, // planModel
    {} as any, // appSettingsModel
    tierModel as any, // tierModel
    {} as any, // ptSlabConfigModel
    {} as any, // subscriptionsService
    {} as any, // addOnsService
    {} as any, // auditService
  );
  return { svc, planModel, tierModel };
};

describe('AdminService Connect plan/tier management (M0.7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getPlans() without a product lists all plans (no product filter)', async () => {
    const { svc, planModel } = build([]);
    await svc.getPlans();
    expect(planModel.find).toHaveBeenCalledWith({});
  });

  it('getPlans("connect") filters by the connect product line', async () => {
    const { svc, planModel } = build([]);
    await svc.getPlans('connect');
    expect(planModel.find).toHaveBeenCalledWith({ product: 'connect' });
  });

  it('getTiers("connect") filters tiers by the connect product line', async () => {
    const { svc, tierModel } = build([], []);
    await svc.getTiers('connect');
    expect(tierModel.find).toHaveBeenCalledWith({ product: 'connect' });
  });

  it('getTiers() without a product lists all tiers', async () => {
    const { svc, tierModel } = build([], []);
    await svc.getTiers();
    expect(tierModel.find).toHaveBeenCalledWith({});
  });

  it('createPlan persists the product + connect allowance block', async () => {
    const { svc, planModel } = build();
    const dto: any = {
      name: 'Connect Premium',
      tier: 'connect_premium',
      monthlyPrice: 499,
      yearlyPrice: 4990,
      product: 'connect',
      entitlements: {
        maxWorkspaces: 0,
        maxMembersPerWorkspace: 0,
        maxTotalMembers: 0,
        modules: [],
        features: {},
        connect: {
          maxListings: -1,
          leadsPerMonth: -1,
          includedBoostCredits: 500,
          verifiedBadge: true,
          searchPriority: 10,
        },
      },
    };
    const result: any = await svc.createPlan(dto);
    expect(planModel).toHaveBeenCalledWith(dto); // full dto handed to the model
    expect(result.product).toBe('connect');
    expect(result.entitlements.connect.includedBoostCredits).toBe(500);
  });
});
