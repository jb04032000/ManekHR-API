import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose, { Types, Model } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  type TestMongo,
} from '../../../../test-utils/mongo-memory';
import { Reaction, ReactionSchema } from '../schemas/reaction.schema';

/**
 * Schema-level proof that post reactions can never be double-counted (task C5).
 *
 * Runs against a real in-memory MongoDB so the unique `{ postId, userId }`
 * index is actually built and enforced — exactly the guarantee `ReactionService`
 * leans on when it upserts a reaction and trusts `upsertedCount` to move the
 * post tally. A retried / double-tapped reaction can only ever resolve to one
 * row, so the count cannot inflate.
 */
describe('Reaction schema — idempotent (no double-count)', () => {
  let mongo: TestMongo;
  let model: Model<Reaction>;

  beforeAll(async () => {
    mongo = await createTestMongoose();
    model = (() => {
      try {
        return mongoose.model<Reaction>(Reaction.name);
      } catch {
        return mongoose.model<Reaction>(Reaction.name, ReactionSchema);
      }
    })();
    await model.syncIndexes();
  });

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
  });

  it('builds the documented unique { postId, userId } index', async () => {
    const indexes = await model.collection.indexes();
    const unique = indexes.find(
      (ix) => ix.key && ix.key.postId === 1 && ix.key.userId === 1 && ix.unique,
    );
    expect(unique).toBeDefined();
  });

  it('upsert is idempotent — a retried react never creates a second row', async () => {
    const postId = new Types.ObjectId();
    const userId = new Types.ObjectId();

    const first = await model
      .updateOne({ postId, userId }, { $setOnInsert: { type: 'like' } }, { upsert: true })
      .exec();
    const second = await model
      .updateOne({ postId, userId }, { $setOnInsert: { type: 'like' } }, { upsert: true })
      .exec();

    // First call inserts; the retry matches the existing row and inserts nothing.
    expect(first.upsertedCount).toBe(1);
    expect(second.upsertedCount).toBe(0);
    expect(await model.countDocuments({ postId, userId })).toBe(1);
  });

  it('the unique index rejects a second raw insert for the same (post,user)', async () => {
    const postId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    await model.create({ postId, userId, type: 'like' });
    // A racing second insert (e.g. two parallel taps that both miss the upsert
    // match) is stopped at the DB by the unique index — duplicate-key error.
    await expect(model.create({ postId, userId, type: 'like' })).rejects.toMatchObject({
      code: 11000,
    });
    expect(await model.countDocuments({ postId, userId })).toBe(1);
  });
});
