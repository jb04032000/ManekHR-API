/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service so the
// transitive schema imports do not trip vitest's reflect-metadata pipeline.
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

import { BadRequestException } from '@nestjs/common';
import { ConnectPromotionService } from '../services/connect-promotion.service';

// Valid 24-hex ObjectId strings (mongoose Types.ObjectId is real here).
const ADMIN = '60a0000000000000000000a1';
const U1 = '60a0000000000000000000b1';
const U2 = '60a0000000000000000000b2';
const U3 = '60a0000000000000000000b3';
const PLAN = '60a0000000000000000000c1';

interface DropDoc {
  _id: string;
  [k: string]: any;
  save: () => Promise<void>;
}

function makeDropModel() {
  const created: DropDoc[] = [];
  const listed: any[] = [];
  const model: any = {
    created,
    listed,
    create: vi.fn(async (input: Record<string, any>) => {
      const doc: DropDoc = {
        ...input,
        _id: `drop-${created.length + 1}`,
        save: vi.fn(async () => undefined),
      };
      created.push(doc);
      return doc;
    }),
    // find().sort().limit().lean().exec() chain for listDrops
    find: vi.fn(() => ({
      sort: () => ({
        limit: () => ({
          lean: () => ({ exec: async () => listed }),
        }),
      }),
    })),
  };
  return model;
}

function makeSubscriptionModel(rows: Array<{ userId: string }>) {
  const lastQuery: { value?: Record<string, any> } = {};
  const model: any = {
    lastQuery,
    find: vi.fn((q: Record<string, any>) => {
      lastQuery.value = q;
      return {
        select: () => ({
          lean: () => ({ exec: async () => rows }),
        }),
      };
    }),
  };
  return model;
}

function makeSvc(opts?: { subs?: Array<{ userId: string }> }) {
  const dropModel = makeDropModel();
  const subscriptionModel = makeSubscriptionModel(opts?.subs ?? []);
  const wallet = { grant: vi.fn(async () => ({})) };
  const audit = { logEvent: vi.fn(async () => undefined) };
  const posthog = { capture: vi.fn() };
  const svc = new ConnectPromotionService(
    dropModel,
    subscriptionModel,
    wallet as any,
    audit as any,
    posthog as any,
  );
  return { svc, dropModel, subscriptionModel, wallet, audit, posthog };
}

describe('ConnectPromotionService.createDrop', () => {
  let env: ReturnType<typeof makeSvc>;

  describe('users mode', () => {
    beforeEach(() => {
      env = makeSvc();
    });

    it('grants each explicit user once, with the drop-keyed idempotency key', async () => {
      const drop = await env.svc.createDrop(ADMIN, {
        amountPerUser: 50,
        note: 'gift',
        targetMode: 'users',
        userIds: [U1, U2],
      });

      expect(env.wallet.grant).toHaveBeenCalledTimes(2);
      expect(env.wallet.grant).toHaveBeenCalledWith(U1, 50, {
        idempotencyKey: `promo-drop-${drop._id}-${U1}`,
      });
      expect(drop.recipientCount).toBe(2);
      expect(drop.totalCreditsGranted).toBe(100);
      expect(drop.save).toHaveBeenCalled();
    });

    it('dedupes a repeated user id', async () => {
      const drop = await env.svc.createDrop(ADMIN, {
        amountPerUser: 10,
        note: 'gift',
        targetMode: 'users',
        userIds: [U1, U1, U2],
      });
      expect(env.wallet.grant).toHaveBeenCalledTimes(2);
      expect(drop.recipientCount).toBe(2);
    });

    it('passes expiresAt through to the grant when provided', async () => {
      const iso = '2026-12-31T00:00:00.000Z';
      const drop = await env.svc.createDrop(ADMIN, {
        amountPerUser: 5,
        note: 'gift',
        targetMode: 'users',
        userIds: [U1],
        expiresAt: iso,
      });
      expect(env.wallet.grant).toHaveBeenCalledWith(U1, 5, {
        idempotencyKey: `promo-drop-${drop._id}-${U1}`,
        expiresAt: new Date(iso),
      });
    });

    it('throws when users mode has no userIds', async () => {
      await expect(
        env.svc.createDrop(ADMIN, {
          amountPerUser: 5,
          note: 'gift',
          targetMode: 'users',
          userIds: [],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(env.dropModel.create).not.toHaveBeenCalled();
    });

    it('audits and emits analytics on success', async () => {
      await env.svc.createDrop(ADMIN, {
        amountPerUser: 5,
        note: 'gift',
        targetMode: 'users',
        userIds: [U1],
      });
      expect(env.audit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'credit_drop_created', actorId: ADMIN }),
      );
      expect(env.posthog.capture).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'connect.credit_drop_created' }),
      );
    });

    it('counts only successful grants when one recipient fails', async () => {
      env.wallet.grant
        .mockImplementationOnce(async () => ({}))
        .mockImplementationOnce(async () => {
          throw new Error('wallet down');
        });
      const drop = await env.svc.createDrop(ADMIN, {
        amountPerUser: 20,
        note: 'gift',
        targetMode: 'users',
        userIds: [U1, U2],
      });
      expect(drop.recipientCount).toBe(1);
      expect(drop.totalCreditsGranted).toBe(20);
    });
  });

  describe('subscribers mode', () => {
    it('targets active connect/bundle subscribers and grants each', async () => {
      env = makeSvc({ subs: [{ userId: U1 }, { userId: U2 }, { userId: U3 }] });
      const drop = await env.svc.createDrop(ADMIN, {
        amountPerUser: 30,
        note: 'all subs',
        targetMode: 'subscribers',
      });
      expect(env.subscriptionModel.lastQuery.value).toMatchObject({
        status: 'active',
        product: { $in: ['connect', 'bundle'] },
      });
      expect(env.wallet.grant).toHaveBeenCalledTimes(3);
      expect(drop.recipientCount).toBe(3);
    });

    it('narrows to a single plan when planId is given', async () => {
      env = makeSvc({ subs: [{ userId: U1 }] });
      await env.svc.createDrop(ADMIN, {
        amountPerUser: 30,
        note: 'plan only',
        targetMode: 'subscribers',
        planId: PLAN,
      });
      expect(env.subscriptionModel.lastQuery.value).toHaveProperty('planId');
    });

    it('throws when no subscriber matches (no drop recorded)', async () => {
      env = makeSvc({ subs: [] });
      await expect(
        env.svc.createDrop(ADMIN, {
          amountPerUser: 30,
          note: 'empty',
          targetMode: 'subscribers',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(env.dropModel.create).not.toHaveBeenCalled();
    });
  });

  describe('listDrops', () => {
    it('returns the model rows', async () => {
      env = makeSvc();
      env.dropModel.listed.push({ _id: 'drop-1', note: 'x' });
      const rows = await env.svc.listDrops();
      expect(rows).toHaveLength(1);
      expect(rows[0]._id).toBe('drop-1');
    });
  });
});
