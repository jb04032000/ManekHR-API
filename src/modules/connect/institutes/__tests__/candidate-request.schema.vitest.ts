/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose, { Types, Model } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  type TestMongo,
} from '../../../../test-utils/mongo-memory';
import {
  CandidateRequest,
  CandidateRequestSchema,
  CANDIDATE_REQUEST_STATUSES,
  CANDIDATE_REQUEST_MESSAGE_MAX,
} from '../schemas/candidate-request.schema';

/**
 * Schema-validation coverage for `CandidateRequest` (Institutes Phase 2, Feature 4:
 * hiring-leads-to-inbox).
 *
 * Runs against a real in-memory MongoDB (mongodb-memory-server) so defaults +
 * validators + index builds are exercised exactly as in production. Verifies:
 *   - a minimal lead materialises every default (status 'sent', empty message);
 *   - the required refs (companyPageId / fromUserId / instituteOwnerUserId) are
 *     enforced;
 *   - the status enum rejects unknown values + accepts every documented value;
 *   - the message maxlength is enforced;
 *   - the documented `{ instituteOwnerUserId, createdAt }` index is built.
 */
describe('CandidateRequest schema', () => {
  let mongo: TestMongo;
  let model: Model<CandidateRequest>;

  beforeAll(async () => {
    mongo = await createTestMongoose();
    // Define-or-reuse so a re-run in the same process does not throw
    // OverwriteModelError.
    model = (() => {
      try {
        return mongoose.model<CandidateRequest>(CandidateRequest.name);
      } catch {
        return mongoose.model<CandidateRequest>(CandidateRequest.name, CandidateRequestSchema);
      }
    })();
    await model.syncIndexes();
    // 60s timeout: mongodb-memory-server may download the MongoDB binary on the very
    // first run on a fresh machine / CI cache.
  }, 60_000);

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    // clearCollections drops documents but keeps indexes, so re-sync defensively.
    await model.syncIndexes();
  });

  const minimal = () => ({
    companyPageId: new Types.ObjectId(),
    fromUserId: new Types.ObjectId(),
    instituteOwnerUserId: new Types.ObjectId(),
  });

  it('persists a minimal lead and materialises every default', async () => {
    const doc = await model.create(minimal());
    expect(doc.status).toBe('sent');
    expect(doc.message).toBe('');
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('requires companyPageId, fromUserId, and instituteOwnerUserId', async () => {
    await expect(
      model.create({
        fromUserId: new Types.ObjectId(),
        instituteOwnerUserId: new Types.ObjectId(),
      }),
    ).rejects.toThrow();
    await expect(
      model.create({
        companyPageId: new Types.ObjectId(),
        instituteOwnerUserId: new Types.ObjectId(),
      }),
    ).rejects.toThrow();
    await expect(
      model.create({ companyPageId: new Types.ObjectId(), fromUserId: new Types.ObjectId() }),
    ).rejects.toThrow();
  });

  it('rejects an unknown status value', async () => {
    await expect(model.create({ ...minimal(), status: 'banished' as any })).rejects.toThrow();
  });

  it('accepts every documented status value', async () => {
    for (const status of CANDIDATE_REQUEST_STATUSES) {
      const doc = await model.create({ ...minimal(), status });
      expect(doc.status).toBe(status);
    }
  });

  it('enforces the message maxlength', async () => {
    await expect(
      model.create({ ...minimal(), message: 'a'.repeat(CANDIDATE_REQUEST_MESSAGE_MAX + 1) }),
    ).rejects.toThrow();
    const ok = await model.create({
      ...minimal(),
      message: 'a'.repeat(CANDIDATE_REQUEST_MESSAGE_MAX),
    });
    expect(ok.message.length).toBe(CANDIDATE_REQUEST_MESSAGE_MAX);
  });

  it('builds the documented { instituteOwnerUserId, createdAt } index', async () => {
    const indexes = await model.collection.indexes();
    const byKey = (key: Record<string, number>) =>
      indexes.find((ix: any) => JSON.stringify(ix.key) === JSON.stringify(key));
    expect(byKey({ instituteOwnerUserId: 1, createdAt: -1 })).toBeDefined();
  });
});
