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

import { Types } from 'mongoose';
import { AdminService } from '../admin.service';

/**
 * Product-aware admin plan assignment.
 *
 * The linchpin: assigning a Connect/bundle plan must (a) supersede only the
 * SAME product group (so a Connect grant never wipes an ERP subscription, and
 * vice versa), and (b) denormalize `product` onto the new subscription from the
 * plan. A bundle replaces both ERP and Connect. ERP entitlements are
 * tier-normalized; connect/bundle entitlements are applied as authored so the
 * `.connect` allowance block survives.
 */
const adminId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();

const findByIdChain = (doc: any) => ({ lean: () => Promise.resolve(doc) });
const findOneChain = (doc: any) => ({ lean: () => Promise.resolve(doc) });

function makeSubModel() {
  const ctor: any = vi.fn().mockImplementation((doc: any) => ({
    ...doc,
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue({ ...doc, _id: new Types.ObjectId() }),
  }));
  ctor.updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
  return ctor;
}

function build(opts: { user?: any; plan?: any; customPlan?: any } = {}) {
  const user = opts.user ?? { _id: new Types.ObjectId(userId), name: 'U' };
  const subModel = makeSubModel();
  const planModel: any = {
    findById: vi.fn(() => findByIdChain(opts.plan ?? null)),
    findOne: vi.fn(() => findOneChain(opts.customPlan ?? null)),
  };
  const userModel: any = { findById: vi.fn(() => findByIdChain(user)) };
  const subscriptionsService: any = {
    // identity normalizer — returns entitlements unchanged (ERP path only).
    normalizeEntitlementsForTier: vi.fn((e: any) => ({ entitlements: e, changed: false })),
  };
  const svc = new AdminService(
    userModel,
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    subModel, // subscriptionModel (constructor + updateMany)
    planModel,
    {} as any, // appSettingsModel
    {} as any, // tierModel
    {} as any, // ptSlabConfigModel
    subscriptionsService,
    {} as any, // addOnsService
    {} as any, // auditService
    {} as any, // userClaimsCache
  );
  return { svc, subModel, planModel, subscriptionsService };
}

const baseEntitlements = {
  maxWorkspaces: 0,
  maxMembersPerWorkspace: 0,
  maxTotalMembers: 0,
  modules: [],
  features: {},
  connect: { maxListings: 25, maxCompanyPages: 1, maxStorefronts: 1, maxJobs: 10 },
};

describe('AdminService.assignPlan — product-aware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assigning a Connect plan supersedes only connect+bundle and tags the new sub product=connect', async () => {
    const { svc, subModel, subscriptionsService } = build({
      plan: {
        _id: new Types.ObjectId(),
        product: 'connect',
        isActive: true,
        tier: 'connect_premium',
      },
    });

    await svc.assignPlan(
      {
        userId,
        planId: new Types.ObjectId().toString(),
        billingCycle: 'monthly',
        entitlements: baseEntitlements as any,
      },
      { _id: adminId },
    );

    // supersede filters never include 'erp' — the ERP subscription is untouched.
    for (const call of subModel.updateMany.mock.calls) {
      expect(call[0]).toMatchObject({ product: { $in: ['connect', 'bundle'] } });
    }
    // new subscription carries product + preserves the connect allowance block (no ERP normalize).
    const created = subModel.mock.calls[0][0];
    expect(created.product).toBe('connect');
    expect(created.appliedEntitlements.connect.maxCompanyPages).toBe(1);
    expect(subscriptionsService.normalizeEntitlementsForTier).not.toHaveBeenCalled();
  });

  it('assigning an ERP plan supersedes only erp+bundle and tags product=erp (connect sub survives)', async () => {
    const { svc, subModel, subscriptionsService } = build({
      plan: { _id: new Types.ObjectId(), product: 'erp', isActive: true, tier: 'pro' },
    });

    await svc.assignPlan(
      {
        userId,
        planId: new Types.ObjectId().toString(),
        billingCycle: 'monthly',
        entitlements: baseEntitlements as any,
      },
      { _id: adminId },
    );

    for (const call of subModel.updateMany.mock.calls) {
      expect(call[0]).toMatchObject({ product: { $in: ['erp', 'bundle'] } });
    }
    const created = subModel.mock.calls[0][0];
    expect(created.product).toBe('erp');
    // ERP path runs tier normalization.
    expect(subscriptionsService.normalizeEntitlementsForTier).toHaveBeenCalled();
  });

  it('assigning a bundle plan supersedes erp+connect+bundle', async () => {
    const { svc, subModel } = build({
      plan: { _id: new Types.ObjectId(), product: 'bundle', isActive: true, tier: 'bundle_pro' },
    });

    await svc.assignPlan(
      {
        userId,
        planId: new Types.ObjectId().toString(),
        billingCycle: 'monthly',
        entitlements: baseEntitlements as any,
      },
      { _id: adminId },
    );

    for (const call of subModel.updateMany.mock.calls) {
      expect(call[0]).toMatchObject({ product: { $in: ['erp', 'connect', 'bundle'] } });
    }
    expect(subModel.mock.calls[0][0].product).toBe('bundle');
  });
});

describe('AdminService.customAssignPlan — product-aware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('custom Connect assignment (no base plan) tags product=connect and scopes supersede', async () => {
    const { svc, subModel } = build({
      customPlan: { _id: new Types.ObjectId(), tier: 'custom' },
    });

    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString();

    await svc.customAssignPlan(
      {
        userId,
        product: 'connect',
        entitlements: baseEntitlements as any,
        startDate: start,
        endDate: end,
        billingCycle: 'monthly',
      } as any,
      { _id: adminId },
    );

    for (const call of subModel.updateMany.mock.calls) {
      expect(call[0]).toMatchObject({ product: { $in: ['connect', 'bundle'] } });
    }
    const created = subModel.mock.calls[0][0];
    expect(created.product).toBe('connect');
    expect(created.appliedEntitlements.connect.maxStorefronts).toBe(1);
  });
});
