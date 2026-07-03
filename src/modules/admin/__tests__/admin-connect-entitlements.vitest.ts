/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

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
// Heavy transitive value-imports — stub so the usage/audit dependency graphs do
// not load into this unit context (mocked at construction instead).
vi.mock('../../connect/usage/connect-usage.service', () => ({ ConnectUsageService: class {} }));
vi.mock('../../audit/audit.service', () => ({ AuditService: class {} }));

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Types } from 'mongoose';
import { AdminConnectEntitlementsService } from '../admin-connect-entitlements.service';
import { AdminConnectEntitlementsOverrideDto } from '../dto/admin-connect-entitlements.dto';
import {
  ConnectAllowanceService,
  CONNECT_FREE_DEFAULT_ALLOWANCES,
} from '../../connect/monetization/connect-allowance.service';
import { IsAdminGuard } from '../../../common/guards/admin.guard';

const USER_ID = '64b8f0c2a1b2c3d4e5f60718';
const USER = { _id: new Types.ObjectId(USER_ID), name: 'Asha', email: 'asha@x.io', mobile: '99' };
const USAGE_ROWS = [
  { kind: 'listing', used: 12, limit: 25, overLimit: false } as any,
  { kind: 'storage', used: 600, limit: 500, overLimit: true } as any,
];

/** A subscription model whose findOne supports BOTH chain shapes the service uses:
 *  - `.exec()`                       → the writable (mutable, save()-able) doc
 *  - `.populate().lean().exec()`     → the lean read view used by getEntitlements */
function makeSubModel(writableDoc: any, leanView: any) {
  const leanChain = { lean: () => leanChain, exec: () => Promise.resolve(leanView) };
  const chain = {
    populate: () => leanChain,
    lean: () => leanChain,
    exec: () => Promise.resolve(writableDoc),
  };
  return { findOne: vi.fn(() => chain) };
}

function makeUserModel(user: any) {
  return {
    findById: vi.fn(() => ({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve(user) }) }),
    })),
  };
}

function makePlanModel(freePlan: any) {
  return {
    findOne: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve(freePlan) }) })),
  };
}

const makeAllowances = (effective: any) => ({
  getAllowances: vi.fn().mockResolvedValue(effective),
});
const makeUsage = () => ({ getUsageForUser: vi.fn().mockResolvedValue(USAGE_ROWS) });
const makeAudit = () => ({ logEvent: vi.fn().mockResolvedValue(undefined) });

const EFFECTIVE = { ...CONNECT_FREE_DEFAULT_ALLOWANCES, maxListings: 100 };

describe('AdminConnectEntitlementsService — GET view', () => {
  it('assembles plan-defaults / override / effective / usage in one call', async () => {
    const sub = {
      _id: new Types.ObjectId(),
      status: 'active',
      appliedEntitlements: { connect: { maxListings: 25, leadsPerMonth: -1 } },
      entitlementsOverride: { connect: { maxListings: 100 } },
      planId: { name: 'Connect Pro', tier: 'connect_pro' },
    };
    const allowances = makeAllowances(EFFECTIVE);
    const usage = makeUsage();
    const svc = new AdminConnectEntitlementsService(
      makeSubModel(null, sub) as any,
      makePlanModel(null) as any,
      makeUserModel(USER) as any,
      allowances as any,
      usage as any,
      makeAudit() as any,
    );

    const view = await svc.getEntitlements(USER_ID);

    expect(view.hasConnectSubscription).toBe(true);
    expect(view.plan).toEqual({ name: 'Connect Pro', tier: 'connect_pro', status: 'active' });
    // Plan defaults = the base block, fully normalized (missing fields filled).
    expect(view.planDefaults.maxListings).toBe(25);
    expect(view.planDefaults.maxJobs).toBe(CONNECT_FREE_DEFAULT_ALLOWANCES.maxJobs);
    // Override = raw connect override block.
    expect(view.override).toEqual({ maxListings: 100 });
    // Effective = authoritative getAllowances() result.
    expect(view.effective.maxListings).toBe(100);
    expect(allowances.getAllowances).toHaveBeenCalledWith(USER_ID);
    expect(view.usage).toBe(USAGE_ROWS);
  });

  it('throws NotFound when the user does not exist', async () => {
    const svc = new AdminConnectEntitlementsService(
      makeSubModel(null, null) as any,
      makePlanModel(null) as any,
      makeUserModel(null) as any,
      makeAllowances(EFFECTIVE) as any,
      makeUsage() as any,
      makeAudit() as any,
    );
    await expect(svc.getEntitlements(USER_ID)).rejects.toThrow('User not found');
  });

  it('throws BadRequest on a malformed user id', async () => {
    const svc = new AdminConnectEntitlementsService(
      makeSubModel(null, null) as any,
      makePlanModel(null) as any,
      makeUserModel(null) as any,
      makeAllowances(EFFECTIVE) as any,
      makeUsage() as any,
      makeAudit() as any,
    );
    await expect(svc.getEntitlements('not-an-id')).rejects.toThrow('Invalid user id');
  });

  it('falls back to the connect_free plan when the person has no Connect subscription', async () => {
    const freePlan = { entitlements: { connect: { maxListings: 25 } } };
    const svc = new AdminConnectEntitlementsService(
      makeSubModel(null, null) as any,
      makePlanModel(freePlan) as any,
      makeUserModel(USER) as any,
      makeAllowances(CONNECT_FREE_DEFAULT_ALLOWANCES) as any,
      makeUsage() as any,
      makeAudit() as any,
    );

    const view = await svc.getEntitlements(USER_ID);
    expect(view.hasConnectSubscription).toBe(false);
    expect(view.subscriptionId).toBeNull();
    expect(view.plan).toBeNull();
    expect(view.override).toBeNull();
    expect(view.planDefaults.maxListings).toBe(25);
  });
});

describe('AdminConnectEntitlementsService — set override', () => {
  function buildWritable(initialOverride?: Record<string, unknown>) {
    const doc: any = {
      _id: new Types.ObjectId(),
      status: 'active',
      appliedEntitlements: { connect: { maxListings: 25 } },
      entitlementsOverride: initialOverride,
      adminEntitlementOverride: !!initialOverride,
      save: vi.fn().mockResolvedValue(undefined),
    };
    return doc;
  }

  function buildSvc(writable: any, audit = makeAudit()) {
    const leanView = {
      _id: writable._id,
      status: 'active',
      appliedEntitlements: { connect: { maxListings: 25 } },
      entitlementsOverride: writable.entitlementsOverride,
      planId: { name: 'Connect Pro', tier: 'connect_pro' },
    };
    return {
      svc: new AdminConnectEntitlementsService(
        makeSubModel(writable, leanView) as any,
        makePlanModel(null) as any,
        makeUserModel(USER) as any,
        makeAllowances(EFFECTIVE) as any,
        makeUsage() as any,
        audit as any,
      ),
      audit,
    };
  }

  it('writes only the supplied fields and flags the override (partial merge)', async () => {
    const writable = buildWritable(undefined);
    const { svc, audit } = buildSvc(writable);

    await svc.setOverride(USER_ID, { maxListings: 50 } as any, 'admin1');

    expect(writable.entitlementsOverride).toEqual({ connect: { maxListings: 50 } });
    expect(writable.adminEntitlementOverride).toBe(true);
    expect(writable.save).toHaveBeenCalledTimes(1);
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    const arg = audit.logEvent.mock.calls[0][0];
    expect(arg.action).toBe('admin_set_connect_entitlement_override');
    expect(arg.actorId).toBe('admin1');
    expect(arg.entityId).toBe(USER_ID);
    expect(arg.before).toBeUndefined();
    expect(arg.after).toEqual({ connect: { maxListings: 50 } });
  });

  it('preserves non-connect override keys (e.g. an ERP block) untouched', async () => {
    const writable = buildWritable({ erp: { foo: 1 } });
    const { svc } = buildSvc(writable);

    await svc.setOverride(USER_ID, { maxListings: 7 } as any, 'admin1');

    expect(writable.entitlementsOverride).toEqual({ erp: { foo: 1 }, connect: { maxListings: 7 } });
  });

  it('whitelists keys — unknown fields never reach the stored override', async () => {
    const writable = buildWritable(undefined);
    const { svc } = buildSvc(writable);

    await svc.setOverride(USER_ID, { maxListings: 5, hacker: true } as any, 'admin1');

    expect(writable.entitlementsOverride).toEqual({ connect: { maxListings: 5 } });
  });

  it('an empty payload clears the connect block but keeps other keys', async () => {
    const writable = buildWritable({ connect: { maxListings: 9 }, erp: { x: 1 } });
    const { svc } = buildSvc(writable);

    await svc.setOverride(USER_ID, {} as any, 'admin1');

    expect(writable.entitlementsOverride).toEqual({ erp: { x: 1 } });
    expect(writable.adminEntitlementOverride).toBe(true);
  });

  it('throws NotFound when the person has no active Connect subscription', async () => {
    const svc = new AdminConnectEntitlementsService(
      makeSubModel(null, null) as any, // .exec() → null writable doc
      makePlanModel(null) as any,
      makeUserModel(USER) as any,
      makeAllowances(EFFECTIVE) as any,
      makeUsage() as any,
      makeAudit() as any,
    );
    await expect(svc.setOverride(USER_ID, { maxListings: 1 } as any, 'admin1')).rejects.toThrow(
      'no active Connect subscription',
    );
  });
});

describe('AdminConnectEntitlementsService — clear override', () => {
  function buildWritable(initialOverride?: Record<string, unknown>) {
    return {
      _id: new Types.ObjectId(),
      status: 'active',
      appliedEntitlements: { connect: { maxListings: 25 } },
      entitlementsOverride: initialOverride,
      adminEntitlementOverride: !!initialOverride,
      save: vi.fn().mockResolvedValue(undefined),
      planId: { name: 'p', tier: 't' },
    } as any;
  }
  function buildSvc(writable: any, audit = makeAudit()) {
    return {
      svc: new AdminConnectEntitlementsService(
        makeSubModel(writable, { ...writable }) as any,
        makePlanModel(null) as any,
        makeUserModel(USER) as any,
        makeAllowances(EFFECTIVE) as any,
        makeUsage() as any,
        audit as any,
      ),
      audit,
    };
  }

  it('removes the connect override entirely and unflags when nothing remains', async () => {
    const writable = buildWritable({ connect: { maxListings: 9 } });
    const { svc, audit } = buildSvc(writable);

    await svc.clearOverride(USER_ID, 'admin1');

    expect(writable.entitlementsOverride).toBeUndefined();
    expect(writable.adminEntitlementOverride).toBe(false);
    expect(audit.logEvent.mock.calls[0][0].action).toBe('admin_clear_connect_entitlement_override');
    expect(audit.logEvent.mock.calls[0][0].before).toEqual({ connect: { maxListings: 9 } });
  });

  it('keeps non-connect keys when clearing the connect block', async () => {
    const writable = buildWritable({ connect: { maxListings: 9 }, erp: { x: 1 } });
    const { svc } = buildSvc(writable);

    await svc.clearOverride(USER_ID, 'admin1');

    expect(writable.entitlementsOverride).toEqual({ erp: { x: 1 } });
    expect(writable.adminEntitlementOverride).toBe(true);
  });
});

describe('AdminConnectEntitlementsOverrideDto — validation', () => {
  const check = async (payload: any) =>
    validate(plainToInstance(AdminConnectEntitlementsOverrideDto, payload));

  it('rejects a numeric allowance below -1', async () => {
    const errs = await check({ maxListings: -2 });
    expect(errs.some((e) => e.property === 'maxListings')).toBe(true);
  });

  it('rejects an unknown over-limit policy', async () => {
    const errs = await check({ overLimitPolicy: 'nope' });
    expect(errs.some((e) => e.property === 'overLimitPolicy')).toBe(true);
  });

  it('rejects graceDays outside [0, 3650]', async () => {
    expect((await check({ overLimitGraceDays: -1 })).length).toBeGreaterThan(0);
    expect((await check({ overLimitGraceDays: 5000 })).length).toBeGreaterThan(0);
  });

  it('accepts -1 (unlimited), a valid policy, and a partial / empty payload', async () => {
    expect(await check({ maxListings: -1 })).toHaveLength(0);
    expect(await check({ overLimitPolicy: 'hide_newest' })).toHaveLength(0);
    expect(await check({})).toHaveLength(0);
    expect(await check({ verifiedBadge: true, maxJobs: 0 })).toHaveLength(0);
  });
});

describe('Override takes effect immediately on getAllowances (no cache)', () => {
  it('a fresh getAllowances reflects a just-written override', async () => {
    const subDoc: any = { appliedEntitlements: { connect: { maxListings: 25 } } };
    const subModel = {
      findOne: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve(subDoc) }) })),
    };
    const planModel = {
      findOne: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve(null) }) })),
    };
    const svc = new ConnectAllowanceService(subModel as any, planModel as any);

    const before = await svc.getAllowances(USER_ID);
    expect(before.maxListings).toBe(25);

    // Simulate the admin write landing on the same subscription doc.
    subDoc.entitlementsOverride = { connect: { maxListings: 99 } };

    const after = await svc.getAllowances(USER_ID);
    expect(after.maxListings).toBe(99); // read per-request → immediate, no invalidation
  });
});

describe('Admin auth gate (IsAdminGuard) protects the endpoints', () => {
  const ctx = (user: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as any;
  const guard = new IsAdminGuard({ getAllAndOverride: () => false } as any);

  it('403s a non-admin caller', () => {
    expect(() => guard.canActivate(ctx({ isAdmin: false }))).toThrow('Admin access required');
    expect(() => guard.canActivate(ctx(undefined))).toThrow('Admin access required');
  });

  it('allows an admin caller', () => {
    expect(guard.canActivate(ctx({ isAdmin: true }))).toBe(true);
  });
});
