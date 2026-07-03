/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { TrendingRefreshService } from '../trending-refresh.service';

function findChain(result: unknown) {
  const c: any = {
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

/** Pass-through single-flight: always wins the claim and runs fn. */
const passThroughLock = {
  runExclusive: vi.fn(async (_jobKey: string, _periodKey: string, fn: () => Promise<unknown>) => ({
    ran: true,
    result: await fn(),
  })),
} as any;

describe('TrendingRefreshService', () => {
  let postModel: any;
  let trendingModel: any;
  const now = Date.now();

  function build(lock: any = passThroughLock) {
    return new TrendingRefreshService(postModel, trendingModel, lock);
  }
  beforeEach(() => {
    vi.clearAllMocks();
    postModel = { find: vi.fn(() => findChain([])) };
    trendingModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  });

  it('upserts the top-scored posts (hottest first) and prunes stale rows', async () => {
    const hot = {
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      reactionCount: 100,
      commentCount: 20,
      repostCount: 5,
      authorErpLinked: false,
      createdAt: new Date(now - 3_600_000),
    };
    const cold = {
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      reactionCount: 0,
      commentCount: 0,
      repostCount: 0,
      authorErpLinked: false,
      createdAt: new Date(now - 20 * 24 * 3_600_000),
    };
    postModel.find = vi.fn(() => findChain([cold, hot]));

    await build().refresh();

    // Convergent upsert (no insertMany / no full deleteMany-then-insert).
    const ops = trendingModel.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(String(ops[0].updateOne.filter.postId)).toBe(String(hot._id)); // hottest first
    expect(ops[0].updateOne.update.$set.score).toBeGreaterThan(ops[1].updateOne.update.$set.score);
    // Prune rows not touched by this run (stale computedAt), not a blanket wipe.
    const pruneFilter = trendingModel.deleteMany.mock.calls[0][0];
    expect(pruneFilter).toHaveProperty('computedAt.$lt');
  });

  it('does not upsert when there is nothing to score (still prunes)', async () => {
    postModel.find = vi.fn(() => findChain([]));
    await build().refresh();
    expect(trendingModel.bulkWrite).not.toHaveBeenCalled();
    expect(trendingModel.deleteMany).toHaveBeenCalled();
  });

  it('is idempotent: running twice issues the same upsert filters (no dup-key path)', async () => {
    const p = {
      _id: new Types.ObjectId(),
      authorId: new Types.ObjectId(),
      reactionCount: 10,
      commentCount: 1,
      repostCount: 0,
      authorErpLinked: false,
      createdAt: new Date(now - 3_600_000),
    };
    postModel.find = vi.fn(() => findChain([p]));
    const svc = build();

    await svc.refresh();
    await svc.refresh();

    const first = trendingModel.bulkWrite.mock.calls[0][0];
    const second = trendingModel.bulkWrite.mock.calls[1][0];
    expect(String(first[0].updateOne.filter.postId)).toBe(String(p._id));
    expect(String(second[0].updateOne.filter.postId)).toBe(String(p._id));
    // Both runs upsert (never insert), so a second run converges instead of
    // colliding on the postId_1 unique index.
    expect(first[0].updateOne.upsert).toBe(true);
    expect(second[0].updateOne.upsert).toBe(true);
  });

  it('does no work when the single-flight claim is held by another worker', async () => {
    const lockHeld = { runExclusive: vi.fn().mockResolvedValue({ ran: false }) } as any;
    await build(lockHeld).refresh();
    expect(postModel.find).not.toHaveBeenCalled();
    expect(trendingModel.bulkWrite).not.toHaveBeenCalled();
    expect(trendingModel.deleteMany).not.toHaveBeenCalled();
  });
});
