/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose, { Types, Model } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  type TestMongo,
} from '../../../../test-utils/mongo-memory';
import {
  ConnectPageInvite,
  ConnectPageInviteSchema,
  CONNECT_PAGE_INVITE_STATUSES,
} from '../schemas/connect-page-invite.schema';

/**
 * Schema-validation coverage for `ConnectPageInvite` (Institutes Phase 2,
 * Feature 5). Runs against a real in-memory MongoDB so index builds + validators
 * are exercised exactly as in production. Verifies:
 *   - the required fields (companyPageId / createdByUserId / inviteeMobile /
 *     inviteExpiry) are enforced;
 *   - defaults materialise (status `invited`, claimedUserId / claimedAt / tokenHash
 *     null);
 *   - the status enum accepts every documented value + rejects unknown;
 *   - the documented indexes ({companyPageId,status} + {inviteeMobile,status}) are
 *     built;
 *   - timestamps are stamped.
 */
describe('ConnectPageInvite schema', () => {
  let mongo: TestMongo;
  let model: Model<ConnectPageInvite>;

  beforeAll(async () => {
    mongo = await createTestMongoose();
    model = (() => {
      try {
        return mongoose.model<ConnectPageInvite>(ConnectPageInvite.name);
      } catch {
        return mongoose.model<ConnectPageInvite>(ConnectPageInvite.name, ConnectPageInviteSchema);
      }
    })();
    await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    await model.syncIndexes();
  });

  function minimal() {
    return {
      companyPageId: new Types.ObjectId(),
      createdByUserId: new Types.ObjectId(),
      inviteeMobile: '919876543210',
      inviteExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  it('persists a minimal invite and materialises every default', async () => {
    const doc = await model.create(minimal());
    expect(doc.status).toBe('invited');
    expect(doc.claimedUserId).toBeNull();
    expect(doc.claimedAt).toBeNull();
    expect(doc.tokenHash).toBeNull();
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('requires companyPageId / createdByUserId / inviteeMobile / inviteExpiry', async () => {
    await expect(model.create({})).rejects.toThrow();
    const { companyPageId, ...noPage } = minimal();
    void companyPageId;
    await expect(model.create(noPage as any)).rejects.toThrow();
    const { inviteeMobile, ...noMobile } = minimal();
    void inviteeMobile;
    await expect(model.create(noMobile as any)).rejects.toThrow();
    const { inviteExpiry, ...noExpiry } = minimal();
    void inviteExpiry;
    await expect(model.create(noExpiry as any)).rejects.toThrow();
  });

  it('accepts every documented status value and rejects an unknown one', async () => {
    for (const status of CONNECT_PAGE_INVITE_STATUSES) {
      const doc = await model.create({ ...minimal(), status });
      expect(doc.status).toBe(status);
    }
    await expect(model.create({ ...minimal(), status: 'bogus' as any })).rejects.toThrow();
  });

  it('persists the claim metadata when set', async () => {
    const claimedUserId = new Types.ObjectId();
    const claimedAt = new Date('2026-06-15T00:00:00.000Z');
    const doc = await model.create({
      ...minimal(),
      status: 'claimed',
      claimedUserId,
      claimedAt,
      tokenHash: 'a'.repeat(64),
    });
    const reloaded = await model.findById(doc._id).lean<any>().exec();
    expect(reloaded.status).toBe('claimed');
    expect(reloaded.claimedUserId.toString()).toBe(claimedUserId.toString());
    expect(new Date(reloaded.claimedAt).toISOString()).toBe(claimedAt.toISOString());
    expect(reloaded.tokenHash).toBe('a'.repeat(64));
  });

  it('builds the documented indexes ({companyPageId,status} + {inviteeMobile,status})', async () => {
    const indexes = await model.collection.indexes();
    const byKey = (key: Record<string, number>) =>
      indexes.find((ix: any) => JSON.stringify(ix.key) === JSON.stringify(key));
    expect(byKey({ companyPageId: 1, status: 1 })).toBeDefined();
    expect(byKey({ inviteeMobile: 1, status: 1 })).toBeDefined();
  });
});
