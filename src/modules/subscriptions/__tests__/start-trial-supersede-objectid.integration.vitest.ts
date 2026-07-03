/**
 * Integration test (real MongoMemoryServer) for the opt-in "Start free trial" 400
 * "Trial already used" bug.
 *
 * The defect is a Mongoose query-casting behavior that mocked models cannot show:
 * the production `Subscription.userId` path resolves to `Mixed` (proven against the
 * live schema), so a filter passed as a raw STRING is NOT cast to an ObjectId and
 * does NOT match a doc that stored userId as an ObjectId. `supersedeCurrent(userId:
 * string)` queries with that raw string, so it fails to supersede the user's active
 * sub; the subsequent trial `create()` then collides with the still-active sub on the
 * `userId_1_product_1` partial-unique index (11000), surfaced as "Trial already used".
 *
 * To exercise the REAL service methods we mock only the @nestjs/mongoose DECORATORS
 * (so subscriptions.service can import — vitest's esbuild emits no decorator metadata,
 * which the union-typed @Prop fields need), then build a REAL Mongoose model whose
 * `userId` path is `Mixed` + carries the real partial-unique index — faithfully
 * reproducing the two production facts that cause the bug.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Neutralise @nestjs/mongoose decorators so importing the service does not trip
// vitest's (metadata-less) decorator pipeline. Mirrors opt-in-trial.vitest.ts.
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
vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { Types, connection, Schema as MongooseSchema } from 'mongoose';
import {
  startMemoryMongo,
  stopMemoryMongo,
  clearAllCollections,
} from '../../../../test-utils/mongo-memory';
import { SubscriptionsService } from '../subscriptions.service';
import { buildModuleAccess } from '../../../common/constants/module-features.registry';

const NOW = new Date('2026-06-24T00:00:00.000Z');

const ENT = (mod: 'free' | 'business') => ({
  maxWorkspaces: 1,
  maxMembersPerWorkspace: 5,
  maxTotalMembers: 5,
  modules: ['team', 'attendance', 'salary'],
  features: { export: false },
  moduleAccess: buildModuleAccess(mod),
});

// Faithful to production: userId/planId/workspaceId resolve to `Mixed` (no casting).
const SubSchema = new MongooseSchema(
  {
    userId: { type: MongooseSchema.Types.Mixed, required: true },
    planId: { type: MongooseSchema.Types.Mixed },
    status: { type: String, default: 'trial' },
    billingCycle: { type: String, default: 'monthly' },
    workspaceId: { type: MongooseSchema.Types.Mixed, default: null },
    product: { type: String, default: 'erp' },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    purchasedEntitlements: { type: Object },
    appliedEntitlements: { type: Object },
    trialEndsAt: Date,
    trialEndedAt: { type: Date, default: null },
    source: { type: String, default: 'self' },
  },
  { timestamps: true },
);
SubSchema.index(
  { userId: 1, product: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['active', 'trial'] } } },
);

const PlanSchemaLocal = new MongooseSchema(
  {
    name: String,
    tier: String,
    product: { type: String, default: 'erp' },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    isTrialPlan: { type: Boolean, default: false },
    isPubliclyVisible: { type: Boolean, default: true },
    trialDurationDays: { type: Number, default: 0 },
    entitlements: { type: Object },
  },
  { timestamps: true },
);

describe('startTrial — supersede must match an ObjectId-stored userId (real method, Mixed path)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let SubModel: any;
  let PlanModel: any;
  let svc: SubscriptionsService;

  beforeAll(async () => {
    await startMemoryMongo();
    SubModel = connection.model('Subscription', SubSchema);
    PlanModel = connection.model('Plan', PlanSchemaLocal);
    await SubModel.syncIndexes(); // build the partial-unique userId_1_product_1

    svc = new SubscriptionsService(
      PlanModel, // planModel
      SubModel, // subscriptionModel
      {} as any, // appSettingsModel (unused by startTrial)
      {} as any, // tierModel
      {} as any, // workspaceModel
      {} as any, // workspaceMemberModel
      {} as any, // addOnsService
      {} as any, // singleFlight
      {} as any, // userModel
      {} as any, // marketing
    );
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  const seedPlans = async () => {
    const freePlan = await PlanModel.create({
      name: 'Free Plan',
      tier: 'free',
      product: 'erp',
      isActive: true,
      isDefault: true,
      trialDurationDays: 0,
      entitlements: ENT('free'),
    });
    await PlanModel.create({
      name: '45 Day Trial',
      tier: 'business',
      product: 'erp',
      isActive: true,
      isTrialPlan: true,
      isPubliclyVisible: false,
      trialDurationDays: 45,
      entitlements: ENT('business'),
    });
    return { freePlan };
  };

  const seedActiveFree = (uid: Types.ObjectId, freePlanId: unknown) =>
    SubModel.create({
      userId: uid, // stored AS AN OBJECTID, like createFreeSubscription
      planId: freePlanId,
      status: 'active',
      product: 'erp',
      purchasedEntitlements: ENT('free'),
      appliedEntitlements: ENT('free'),
      source: 'self',
    });

  it('supersedeCurrent supersedes an active sub whose userId is stored as an ObjectId', async () => {
    const { freePlan } = await seedPlans();
    const uid = new Types.ObjectId();
    const active = await seedActiveFree(uid, freePlan._id);

    // Called with the raw STRING userId (exactly as the controller passes req.user.sub).
    await svc.supersedeCurrent(uid.toString());

    const after = await SubModel.findById(active._id).lean();
    expect(after?.status).toBe('superseded');
  });

  it('startTrial creates a trial (no "Trial already used") for a fresh ObjectId-userId account', async () => {
    const { freePlan } = await seedPlans();
    const uid = new Types.ObjectId();
    await seedActiveFree(uid, freePlan._id);

    const trial: any = await svc.startTrial(uid.toString(), 'erp', NOW);
    expect(trial.status).toBe('trial');

    const trials = await SubModel.find({ userId: uid, status: 'trial' }).lean();
    expect(trials.length).toBe(1);

    const actives = await SubModel.find({ userId: uid, status: 'active' }).lean();
    expect(actives.length).toBe(0);
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
