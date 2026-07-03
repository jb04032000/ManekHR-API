/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
 * Unified users console: product filter + per-product summaries.
 *   - product='connect' constrains the candidate userId set BEFORE pagination
 *     (Connect is removed from ManekHR; the footprint now only queries legacy
 *     connect|bundle subscriptions),
 *   - active/trial subs split per product (a bundle sub feeds BOTH summaries),
 *   - isErpUser from footprint (workspace) plus subscription presence;
 *     isConnectUser purely from subscription presence.
 */
const userChain = (rows: any[]) => {
  const chain: any = {};
  chain.sort = () => chain;
  chain.skip = () => chain;
  chain.limit = () => chain;
  chain.select = () => chain;
  chain.lean = () => Promise.resolve(rows);
  return chain;
};

function build(opts: {
  users?: any[];
  total?: number;
  subs?: any[];
  connectSubDistinct?: any[];
  erpMemberDistinct?: any[];
  erpSubDistinct?: any[];
}) {
  const userModel: any = {
    find: vi.fn(() => userChain(opts.users ?? [])),
    countDocuments: vi.fn(() => Promise.resolve(opts.total ?? (opts.users ?? []).length)),
  };
  const subscriptionModel: any = {
    distinct: vi.fn((_field: string, query: any) => {
      const prods = query?.product?.$in ?? [];
      return Promise.resolve(
        prods.includes('connect') ? (opts.connectSubDistinct ?? []) : (opts.erpSubDistinct ?? []),
      );
    }),
    find: vi.fn(() => ({ populate: () => ({ lean: () => Promise.resolve(opts.subs ?? []) }) })),
  };
  const workspaceMemberModel: any = {
    distinct: vi.fn(() => Promise.resolve(opts.erpMemberDistinct ?? [])),
    aggregate: vi.fn(() => Promise.resolve([])),
  };
  const svc = new AdminService(
    userModel,
    {} as any, // workspaceModel
    workspaceMemberModel,
    subscriptionModel,
    {} as any, // planModel
    {} as any, // appSettingsModel
    {} as any, // tierModel
    {} as any, // ptSlabConfigModel
    {} as any, // subscriptionsService
    {} as any, // addOnsService
    {} as any, // auditService
    {} as any, // userClaimsCache
  );
  return { svc, userModel, subscriptionModel };
}

describe('AdminService.getUsers — product filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it("product='connect' constrains the candidate set before pagination", async () => {
    const u2 = new Types.ObjectId();
    const { svc, userModel, subscriptionModel } = build({
      users: [],
      connectSubDistinct: [u2], // legacy connect/bundle subscriber
    });

    await svc.getUsers({ product: 'connect' } as any);

    expect(subscriptionModel.distinct).toHaveBeenCalledWith(
      'userId',
      expect.objectContaining({ product: { $in: ['connect', 'bundle'] } }),
    );
    const filter = userModel.find.mock.calls[0][0];
    expect(filter._id.$in).toHaveLength(1);
    expect(String(filter._id.$in[0])).toBe(u2.toString());
  });
});

describe('AdminService.getUsers — per-product summaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('splits erp / connect / bundle subscriptions and sets footprint flags', async () => {
    const erpId = new Types.ObjectId();
    const connId = new Types.ObjectId();
    const bundleId = new Types.ObjectId();

    const { svc } = build({
      users: [
        { _id: erpId, name: 'Erp' },
        { _id: connId, name: 'Conn' },
        { _id: bundleId, name: 'Both' },
      ],
      subs: [
        { userId: erpId, product: 'erp', status: 'active', planId: { name: 'Pro', tier: 'pro' } },
        {
          userId: connId,
          product: 'connect',
          status: 'active',
          planId: { name: 'C', tier: 'connect_premium' },
        },
        {
          userId: bundleId,
          product: 'bundle',
          status: 'active',
          planId: { name: 'B', tier: 'bundle' },
        },
      ],
    });

    const res: any = await svc.getUsers({ product: 'all' } as any);
    const byId = new Map<string, any>(res.data.map((u: any) => [u._id.toString(), u]));

    const erp = byId.get(erpId.toString());
    expect(erp.isErpUser).toBe(true);
    expect(erp.isConnectUser).toBe(false);
    expect(erp.erpSubscription.planName).toBe('Pro');
    expect(erp.connectSubscription).toBeNull();

    const conn = byId.get(connId.toString());
    expect(conn.isErpUser).toBe(false);
    expect(conn.isConnectUser).toBe(true);
    expect(conn.connectSubscription.planTier).toBe('connect_premium');
    expect(conn.erpSubscription).toBeNull();

    const both = byId.get(bundleId.toString());
    expect(both.isErpUser).toBe(true);
    expect(both.isConnectUser).toBe(true);
    expect(both.erpSubscription.product).toBe('bundle');
    expect(both.connectSubscription.product).toBe('bundle');
  });

  // Opt-in trial: a trialing user sits on the Free/default plan with status
  // 'trial' (so they cleanly drop back to Free at expiry). The summary must
  // carry status:'trial' + trialEndsAt so the admin Users list can show a
  // Trial badge + end date. Keep in sync with admin/users/page.tsx.
  it('surfaces status:trial and trialEndsAt on the erp summary for a trialing user', async () => {
    const trialId = new Types.ObjectId();
    const trialEndsAt = new Date('2026-07-15T00:00:00.000Z');

    const { svc } = build({
      users: [{ _id: trialId, name: 'Trialing' }],
      subs: [
        {
          userId: trialId,
          product: 'erp',
          status: 'trial',
          trialEndsAt,
          planId: { name: 'Free', tier: 'free' },
        },
      ],
    });

    const res: any = await svc.getUsers({ product: 'all' } as any);
    const user = res.data[0];

    expect(user.erpSubscription.status).toBe('trial');
    expect(user.erpSubscription.planName).toBe('Free');
    expect(user.erpSubscription.trialEndsAt).toEqual(trialEndsAt);
  });

  // Non-trial subscriptions carry no trial end; trialEndsAt falls back to null
  // (the schema field is absent), never undefined, so the FE guard is simple.
  it('sets trialEndsAt to null when the subscription is not on a trial', async () => {
    const activeId = new Types.ObjectId();
    const { svc } = build({
      users: [{ _id: activeId, name: 'Active' }],
      subs: [
        {
          userId: activeId,
          product: 'erp',
          status: 'active',
          planId: { name: 'Pro', tier: 'pro' },
        },
      ],
    });

    const res: any = await svc.getUsers({ product: 'all' } as any);
    expect(res.data[0].erpSubscription.trialEndsAt).toBeNull();
  });
});
