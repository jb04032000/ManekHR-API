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
 * "Show demo accounts" toggle on the admin Users list. Mirrors the includeDeleted
 * behaviour: seeded demo/sample accounts (User.isDemo:true) are HIDDEN by default
 * and only listed when includeDemo=true. isDemo must survive onto each returned
 * item so the FE can tag demo rows. Keep in sync with admin/users/page.tsx.
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

function build(opts: { users?: any[]; total?: number }) {
  const userModel: any = {
    find: vi.fn(() => userChain(opts.users ?? [])),
    countDocuments: vi.fn(() => Promise.resolve(opts.total ?? (opts.users ?? []).length)),
  };
  const subscriptionModel: any = {
    distinct: vi.fn(() => Promise.resolve([])),
    find: vi.fn(() => ({ populate: () => ({ lean: () => Promise.resolve([]) }) })),
  };
  const workspaceMemberModel: any = {
    distinct: vi.fn(() => Promise.resolve([])),
    aggregate: vi.fn(() => Promise.resolve([])),
  };
  const connectProfileModel: any = {
    distinct: vi.fn(() => Promise.resolve([])),
    find: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })),
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
    connectProfileModel,
  );
  return { svc, userModel };
}

describe('AdminService.getUsers — demo account toggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes isDemo accounts by default (includeDemo absent)', async () => {
    const { svc, userModel } = build({ users: [{ _id: new Types.ObjectId(), name: 'Real' }] });

    await svc.getUsers({ product: 'all' } as any);

    const filter = userModel.find.mock.calls[0][0];
    expect(filter.isDemo).toEqual({ $ne: true });
  });

  it('includes demo accounts when includeDemo=true (no isDemo filter)', async () => {
    const { svc, userModel } = build({ users: [{ _id: new Types.ObjectId(), name: 'Demo' }] });

    await svc.getUsers({ product: 'all', includeDemo: true } as any);

    const filter = userModel.find.mock.calls[0][0];
    expect(filter.isDemo).toBeUndefined();
  });

  it('surfaces isDemo on each returned item so the FE can tag demo rows', async () => {
    const realId = new Types.ObjectId();
    const demoId = new Types.ObjectId();
    const { svc } = build({
      users: [
        { _id: realId, name: 'Real', isDemo: false },
        { _id: demoId, name: 'Demo', isDemo: true },
      ],
    });

    const res: any = await svc.getUsers({ product: 'all', includeDemo: true } as any);
    const byId = new Map(res.data.map((u: any) => [u._id.toString(), u]));

    expect(byId.get(realId.toString()).isDemo).toBe(false);
    expect(byId.get(demoId.toString()).isDemo).toBe(true);
  });
});
