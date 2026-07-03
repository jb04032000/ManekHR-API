/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the transitive
// decorated schema imports don't trip vitest's reflect-metadata pipeline (same
// pattern as subscriptions/__tests__/opt-in-trial.vitest.ts).
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { CustomPlanRequestsService } from '../custom-plan-requests.service';

const USER_1 = '0123456789abcdef01234567';
const ADMIN_1 = '0123456789abcdef0123aaaa';
const REQ_ID = '0123456789abcdef0123bbbb';

function buildSvc(over: { model?: any; userModel?: any; posthog?: any } = {}) {
  const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const svc = new CustomPlanRequestsService(
    over.model ?? ({} as any),
    over.userModel ?? ({} as any),
    audit as any,
    over.posthog,
  );
  return { svc, audit };
}

const userModelReturning = (u: any) => ({
  findById: vi.fn(() => ({
    select: vi.fn(() => ({ lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(u) })) })),
  })),
});

describe('CustomPlanRequestsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create: denormalizes user, trims, defaults, sets status new, audits + posthog', async () => {
    const created: any[] = [];
    const model = {
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: REQ_ID, ...doc });
      }),
    };
    const userModel = userModelReturning({ name: ' Asha ', email: ' a@x.com ' });
    const posthog = { capture: vi.fn() };
    const { svc, audit } = buildSvc({ model, userModel, posthog });

    const out: any = await svc.create(USER_1, {
      teamMembers: 750,
      mobile: ' +91 98765 43210 ',
      note: '  3 shifts, 2 units  ',
    } as any);

    const doc = created[0];
    expect(doc.userName).toBe('Asha');
    expect(doc.userEmail).toBe('a@x.com');
    expect(doc.teamMembers).toBe(750);
    expect(doc.companiesOrFactories).toBe(0); // defaulted when omitted
    expect(doc.mobile).toBe('+91 98765 43210'); // trimmed
    expect(doc.note).toBe('3 shifts, 2 units'); // trimmed
    expect(doc.status).toBe('new');
    expect(doc.product).toBe('erp'); // defaulted
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(out._id).toBe(REQ_ID);
  });

  it('create: stamps kind="custom" so the discriminator is explicit', async () => {
    const created: any[] = [];
    const model = {
      create: vi.fn((d: any) => {
        created.push(d);
        return Promise.resolve({ _id: REQ_ID, ...d });
      }),
    };
    const { svc } = buildSvc({
      model,
      userModel: userModelReturning({ name: 'A', email: 'a@x.com' }),
    });

    await svc.create(USER_1, { teamMembers: 5, mobile: '9876543210' } as any);

    expect(created[0].kind).toBe('custom');
  });

  it('createPlanInterest: kind="plan", casts planId, denormalizes plan + user, audits + posthog', async () => {
    const created: any[] = [];
    const model = {
      create: vi.fn((doc: any) => {
        created.push(doc);
        return Promise.resolve({ _id: REQ_ID, ...doc });
      }),
    };
    const userModel = userModelReturning({ name: ' Ravi ', email: ' r@x.com ' });
    const posthog = { capture: vi.fn() };
    const { svc, audit } = buildSvc({ model, userModel, posthog });

    const out: any = await svc.createPlanInterest(USER_1, {
      planId: REQ_ID,
      planTier: ' growth ',
      planName: ' Growth ',
      mobile: ' +91 90000 00000 ',
      teamMembers: 60,
    } as any);

    const doc = created[0];
    expect(doc.kind).toBe('plan');
    expect(String(doc.planId)).toBe(REQ_ID); // cast to ObjectId
    expect(doc.planTier).toBe('growth'); // trimmed
    expect(doc.planName).toBe('Growth'); // trimmed
    expect(doc.userName).toBe('Ravi');
    expect(doc.mobile).toBe('+91 90000 00000'); // trimmed
    expect(doc.teamMembers).toBe(60);
    expect(doc.companiesOrFactories).toBe(0); // defaulted when omitted
    expect(doc.status).toBe('new');
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    expect(audit.logEvent.mock.calls[0][0].action).toBe('plan_interest_request_created');
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(out._id).toBe(REQ_ID);
  });

  it('createPlanInterest: team size is optional (omitted -> undefined)', async () => {
    const created: any[] = [];
    const model = {
      create: vi.fn((d: any) => {
        created.push(d);
        return Promise.resolve({ _id: REQ_ID, ...d });
      }),
    };
    const { svc } = buildSvc({ model, userModel: userModelReturning(null) });

    await svc.createPlanInterest(USER_1, {
      planId: REQ_ID,
      planTier: 'starter',
      planName: 'Starter',
      mobile: '9876543210',
    } as any);

    expect(created[0].teamMembers).toBeUndefined();
    expect(created[0].kind).toBe('plan');
  });

  it('create: tolerates a missing user profile (empty name/email)', async () => {
    const created: any[] = [];
    const model = {
      create: vi.fn((d: any) => {
        created.push(d);
        return Promise.resolve({ _id: REQ_ID, ...d });
      }),
    };
    const { svc } = buildSvc({ model, userModel: userModelReturning(null) });

    await svc.create(USER_1, {
      teamMembers: 10,
      companiesOrFactories: 2,
      mobile: '9876543210',
    } as any);

    expect(created[0].userName).toBe('');
    expect(created[0].userEmail).toBe('');
    expect(created[0].companiesOrFactories).toBe(2);
  });

  it('adminList: status filter + newest-first + clamps limit to 100 + returns total', async () => {
    const items = [{ _id: 'a' }, { _id: 'b' }];
    const chain: any = {};
    chain.sort = vi.fn(() => chain);
    chain.skip = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.lean = vi.fn(() => chain);
    chain.exec = vi.fn().mockResolvedValue(items);
    const model = {
      find: vi.fn(() => chain),
      countDocuments: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(2) })),
    };
    const { svc } = buildSvc({ model });

    const res = await svc.adminList({ status: 'new', limit: 999, offset: 0 });

    expect(model.find).toHaveBeenCalledWith({ status: 'new' });
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(chain.limit).toHaveBeenCalledWith(100); // clamped from 999
    expect(res).toEqual({ items, total: 2, limit: 100, offset: 0 });
  });

  it('adminList: kind filter narrows the query (custom vs plan leads)', async () => {
    const chain: any = {};
    chain.sort = vi.fn(() => chain);
    chain.skip = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.lean = vi.fn(() => chain);
    chain.exec = vi.fn().mockResolvedValue([]);
    const model = {
      find: vi.fn(() => chain),
      countDocuments: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(0) })),
    };
    const { svc } = buildSvc({ model });

    await svc.adminList({ kind: 'plan' });

    expect(model.find).toHaveBeenCalledWith({ kind: 'plan' });
  });

  it('adminUpdate: invalid id -> NotFound, no write, no audit', async () => {
    const model = { findByIdAndUpdate: vi.fn() };
    const { svc, audit } = buildSvc({ model });

    await expect(svc.adminUpdate('not-an-id', ADMIN_1, { status: 'contacted' })).rejects.toThrow(
      /not found/i,
    );
    expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(audit.logEvent).not.toHaveBeenCalled();
  });

  it('adminUpdate: sets status + trimmed note + handledBy, audits, returns doc', async () => {
    const updated = { _id: REQ_ID, status: 'contacted' };
    let capturedUpdate: any;
    const model = {
      findByIdAndUpdate: vi.fn((_id: string, upd: any) => {
        capturedUpdate = upd;
        return { lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(updated) })) };
      }),
    };
    const { svc, audit } = buildSvc({ model });

    const res = await svc.adminUpdate(REQ_ID, ADMIN_1, {
      status: 'contacted',
      adminNote: ' called, will follow up ',
    });

    expect(capturedUpdate.$set.status).toBe('contacted');
    expect(capturedUpdate.$set.adminNote).toBe('called, will follow up'); // trimmed
    expect(String(capturedUpdate.$set.handledByUserId)).toBe(ADMIN_1);
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    expect(res).toBe(updated);
  });

  it('adminUpdate: 404 when the request id does not exist', async () => {
    const model = {
      findByIdAndUpdate: vi.fn(() => ({
        lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
      })),
    };
    const { svc, audit } = buildSvc({ model });

    await expect(svc.adminUpdate(REQ_ID, ADMIN_1, { status: 'closed' })).rejects.toThrow(
      /not found/i,
    );
    expect(audit.logEvent).not.toHaveBeenCalled();
  });
});
