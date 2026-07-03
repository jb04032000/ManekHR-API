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
import { NotFoundException } from '@nestjs/common';
import { AdminService } from '../admin.service';

/**
 * Admin-side "assign configured DEFAULT ERP plan" — single-user + bulk backfill.
 *
 * Because createFreeSubscription's idempotency guard returns the existing sub
 * when ANY sub exists (active OR stale), these methods use the assignPlan-style
 * supersede+create-active path so a no-active-plan user (even one with only a
 * stale/expired/superseded sub) is GUARANTEED to land ACTIVE on the default plan.
 */
const adminId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();

const findByIdChain = (doc: any) => ({ lean: () => Promise.resolve(doc) });

function makeSubModel() {
  const ctor: any = vi.fn().mockImplementation((doc: any) => ({
    ...doc,
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue({ ...doc, _id: new Types.ObjectId() }),
  }));
  ctor.updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
  // findOne is used to detect an existing ACTIVE/trial ERP sub (skip path).
  ctor.findOne = vi.fn(() => ({ lean: () => Promise.resolve(null) }));
  // distinct backs the bulk candidate query (users WITH an active/trial sub).
  ctor.distinct = vi.fn().mockResolvedValue([]);
  return ctor;
}

function build(
  opts: {
    user?: any;
    defaultPlan?: any; // plan doc returned by planModel.findById(defaultPlanId)
    defaultPlanId?: any; // value getDefaultPlanId resolves to
    activeSub?: any; // existing active/trial ERP sub (skip path)
    distinctActiveUserIds?: any[]; // userIds WITH an active/trial sub (bulk)
    candidateUsers?: any[]; // userModel.find() result for the bulk candidate query
  } = {},
) {
  // Distinguish "not provided" (default user) from explicit null (missing user).
  const user = 'user' in opts ? opts.user : { _id: new Types.ObjectId(userId), name: 'U' };
  const subModel = makeSubModel();
  if (opts.activeSub !== undefined) {
    subModel.findOne = vi.fn(() => ({ lean: () => Promise.resolve(opts.activeSub) }));
  }
  if (opts.distinctActiveUserIds !== undefined) {
    subModel.distinct = vi.fn().mockResolvedValue(opts.distinctActiveUserIds);
  }

  const planModel: any = {
    findById: vi.fn(() => findByIdChain(opts.defaultPlan ?? null)),
  };
  const userModel: any = {
    findById: vi.fn(() => findByIdChain(user)),
    // Bulk candidate query: find non-admin, non-deleted users not already covered.
    find: vi.fn(() => ({
      select: () => ({ lean: () => Promise.resolve(opts.candidateUsers ?? []) }),
    })),
  };
  const subscriptionsService: any = {
    getDefaultPlanId: vi
      .fn()
      .mockResolvedValue(
        opts.defaultPlanId !== undefined ? opts.defaultPlanId : new Types.ObjectId(),
      ),
    normalizeEntitlementsForTier: vi.fn((e: any) => ({ entitlements: e, changed: false })),
  };
  const auditService: any = { logEvent: vi.fn().mockResolvedValue(undefined) };

  const svc = new AdminService(
    userModel,
    {} as any, // workspaceModel
    {} as any, // workspaceMemberModel
    subModel, // subscriptionModel (constructor + updateMany + findOne + distinct)
    planModel,
    {} as any, // appSettingsModel
    {} as any, // tierModel
    {} as any, // ptSlabConfigModel
    subscriptionsService,
    {} as any, // addOnsService
    auditService,
    {} as any, // userClaimsCache
    {} as any, // connectProfileModel
  );
  return { svc, subModel, planModel, userModel, subscriptionsService, auditService };
}

const erpPlan = {
  _id: new Types.ObjectId(),
  name: 'Free Forever',
  product: 'erp',
  isActive: true,
  tier: 'free',
  entitlements: {
    maxWorkspaces: 1,
    maxMembersPerWorkspace: 5,
    maxTotalMembers: 5,
    modules: [],
    features: {},
  },
};

describe('AdminService.assignDefaultPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('(a) no-sub user → creates an ACTIVE ERP sub on the default plan + audits', async () => {
    const { svc, subModel, auditService } = build({
      defaultPlanId: erpPlan._id,
      defaultPlan: erpPlan,
      activeSub: null, // no active/trial ERP sub
    });

    const res = await svc.assignDefaultPlan(userId, { _id: adminId });

    expect(res.assigned).toBe(true);
    expect(res.planName).toBeDefined();
    // A new subscription was created, ACTIVE, ERP, on the default plan.
    const created = subModel.mock.calls[0][0];
    expect(created.status).toBe('active');
    expect(created.product).toBe('erp');
    expect(String(created.planId)).toBe(String(erpPlan._id));
    expect(created.source).toBe('admin');
    // Audited under the SUBSCRIPTION module.
    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    expect(auditService.logEvent.mock.calls[0][0]).toMatchObject({
      module: 'subscription',
      action: 'admin_assign_default',
    });
  });

  it('(b) no default plan configured → throws NotFoundException', async () => {
    const { svc } = build({ defaultPlanId: null });
    await expect(svc.assignDefaultPlan(userId, { _id: adminId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('(c) user already has an active ERP sub → returns assigned:false (no duplicate)', async () => {
    const { svc, subModel, auditService } = build({
      defaultPlanId: erpPlan._id,
      defaultPlan: erpPlan,
      activeSub: { _id: new Types.ObjectId(), status: 'active', product: 'erp' },
    });

    const res = await svc.assignDefaultPlan(userId, { _id: adminId });

    expect(res.assigned).toBe(false);
    expect(res.reason).toBe('already-has-plan');
    // No new subscription created, no audit write.
    expect(subModel).not.toHaveBeenCalled();
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the user does not exist', async () => {
    const { svc } = build({ user: null, defaultPlanId: erpPlan._id, defaultPlan: erpPlan });
    await expect(
      svc.assignDefaultPlan(new Types.ObjectId().toString(), { _id: adminId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminService.assignDefaultPlanToUsersWithoutPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assigns only to users without an active/trial sub and returns correct counts', async () => {
    const withPlanId = new Types.ObjectId();
    const noPlanA = new Types.ObjectId();
    const noPlanB = new Types.ObjectId();

    const { svc, subModel, auditService } = build({
      defaultPlanId: erpPlan._id,
      defaultPlan: erpPlan,
      // distinct returns the user already covered; candidate query already excludes it.
      distinctActiveUserIds: [withPlanId],
      // candidate query returns only the two uncovered users.
      candidateUsers: [{ _id: noPlanA }, { _id: noPlanB }],
      activeSub: null, // each per-user assign sees no active sub
    });

    const res = await svc.assignDefaultPlanToUsersWithoutPlan({ _id: adminId });

    expect(res.total).toBe(2);
    expect(res.assigned).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.failed).toBe(0);
    // Two subscriptions created (one per uncovered user).
    expect(subModel.mock.calls.length).toBe(2);
    expect(auditService.logEvent).toHaveBeenCalledTimes(2);
  });

  it('isolates a per-user failure: one assign throws → counts it as failed and finishes the pass', async () => {
    const noPlanA = new Types.ObjectId();
    const noPlanB = new Types.ObjectId();

    const { svc } = build({
      defaultPlanId: erpPlan._id,
      defaultPlan: erpPlan,
      candidateUsers: [{ _id: noPlanA }, { _id: noPlanB }],
      activeSub: null,
    });

    // First user assigns fine; the second user's per-row assign throws (e.g. a
    // surviving E11000, a transient DB error, or a NotFound from a race). The
    // loop must isolate it: count the failure and keep going, not 500 the pass.
    const assignSpy = vi
      .spyOn(svc, 'assignDefaultPlan')
      .mockResolvedValueOnce({ assigned: true, planName: 'Free Forever' })
      .mockRejectedValueOnce(new Error('boom on user B'));

    const res = await svc.assignDefaultPlanToUsersWithoutPlan({ _id: adminId });

    // The loop COMPLETED (both candidates visited) and the throw was counted,
    // not propagated — assigned 1, failed 1, skipped 0, total 2.
    expect(assignSpy).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ assigned: 1, skipped: 0, failed: 1, total: 2 });
  });

  it('no candidates → assigns 0, total 0', async () => {
    const { svc, subModel } = build({
      defaultPlanId: erpPlan._id,
      defaultPlan: erpPlan,
      candidateUsers: [],
    });
    const res = await svc.assignDefaultPlanToUsersWithoutPlan({ _id: adminId });
    expect(res).toEqual({ assigned: 0, skipped: 0, failed: 0, total: 0 });
    expect(subModel).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when no default plan is configured', async () => {
    const { svc } = build({ defaultPlanId: null });
    await expect(svc.assignDefaultPlanToUsersWithoutPlan({ _id: adminId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
