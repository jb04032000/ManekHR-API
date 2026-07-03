/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the processor so the transitive schema
// imports (FeedEntry / Post and their `User` refs) don't trip SchemaFactory's
// reflection under vitest's esbuild transform. Every Model is a plain mock here.
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

import { Types } from 'mongoose';
import { FeedFanoutProcessor } from '../feed-fanout.processor';

/** A `postModel.find(...)` chain whose `.exec()` resolves `result`. */
function postFindChain(result: unknown) {
  const c: any = {
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

/**
 * Phase 7b — feed fan-out worker. Locks the two bug fixes:
 *  - the AUTHOR is always a fan-out recipient (own post can't go missing);
 *  - the realtime nudge fires for followers only;
 *  - the `backfill` job mode copies a peer's recent posts into a new
 *    follower's feed (closes the connect-after-post gap).
 */
describe('FeedFanoutProcessor — fan-out + backfill (Phase 7b)', () => {
  let feedEntryModel: any;
  let postModel: any;
  let networkService: any;
  let gateway: any;

  const author = new Types.ObjectId();
  const followerB = new Types.ObjectId();
  const followerC = new Types.ObjectId();

  function build() {
    return new FeedFanoutProcessor(feedEntryModel, postModel, networkService, gateway);
  }
  function job(data: any) {
    return { data } as any;
  }

  beforeEach(() => {
    feedEntryModel = { bulkWrite: vi.fn().mockResolvedValue({ upsertedCount: 0 }) };
    postModel = { find: vi.fn(() => postFindChain([])) };
    networkService = {
      listFollowerIds: vi.fn().mockResolvedValue([]),
      listCompanyPageFollowerIds: vi.fn().mockResolvedValue([]),
    };
    gateway = { emitNewPost: vi.fn() };
  });

  // ── fan-out ────────────────────────────────────────────────────────────
  it('writes a FeedEntry for every follower AND the author (own post never missing)', async () => {
    networkService.listFollowerIds = vi
      .fn()
      .mockResolvedValue([String(followerB), String(followerC)]);
    const postId = new Types.ObjectId();

    await build().process(
      job({
        postId: String(postId),
        authorId: String(author),
        postedAt: new Date().toISOString(),
      }),
    );

    expect(feedEntryModel.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = feedEntryModel.bulkWrite.mock.calls[0][0];
    const owners = ops.map((o: any) => String(o.updateOne.filter.ownerId));
    expect(owners).toContain(String(author));
    expect(owners).toContain(String(followerB));
    expect(owners).toContain(String(followerC));
    expect(owners.length).toBe(3); // deduped, author + 2 followers
    for (const o of ops) {
      expect(String(o.updateOne.update.$setOnInsert.authorId)).toBe(String(author));
      expect(o.updateOne.upsert).toBe(true);
    }
  });

  it('emits the realtime nudge to followers only (never the author)', async () => {
    networkService.listFollowerIds = vi.fn().mockResolvedValue([String(followerB)]);
    await build().process(
      job({
        postId: String(new Types.ObjectId()),
        authorId: String(author),
        postedAt: new Date().toISOString(),
      }),
    );
    expect(gateway.emitNewPost).toHaveBeenCalledTimes(1);
    expect(gateway.emitNewPost.mock.calls[0][0]).toEqual([String(followerB)]);
  });

  it('with no followers still writes the author entry and emits nothing', async () => {
    networkService.listFollowerIds = vi.fn().mockResolvedValue([]);
    await build().process(
      job({
        postId: String(new Types.ObjectId()),
        authorId: String(author),
        postedAt: new Date().toISOString(),
      }),
    );
    const ops = feedEntryModel.bulkWrite.mock.calls[0][0];
    expect(ops.length).toBe(1);
    expect(String(ops[0].updateOne.filter.ownerId)).toBe(String(author));
    expect(gateway.emitNewPost).not.toHaveBeenCalled();
  });

  // ── page posts ───────────────────────────────────────────────────────────
  it('a page post fans out to the PAGE followers (not the author personal followers) and stamps companyPageId', async () => {
    const pageId = new Types.ObjectId();
    networkService.listCompanyPageFollowerIds = vi.fn().mockResolvedValue([String(followerB)]);
    networkService.listFollowerIds = vi.fn().mockResolvedValue([String(followerC)]); // must NOT be used

    await build().process(
      job({
        postId: String(new Types.ObjectId()),
        authorId: String(author),
        postedAt: new Date().toISOString(),
        companyPageId: String(pageId),
      }),
    );

    expect(networkService.listCompanyPageFollowerIds).toHaveBeenCalledWith(String(pageId));
    expect(networkService.listFollowerIds).not.toHaveBeenCalled();
    const ops = feedEntryModel.bulkWrite.mock.calls[0][0];
    const owners = ops.map((o: any) => String(o.updateOne.filter.ownerId));
    expect(owners).toContain(String(author)); // page owner sees their own page post
    expect(owners).toContain(String(followerB)); // page follower
    expect(owners).not.toContain(String(followerC)); // personal follower excluded
    for (const o of ops) {
      expect(String(o.updateOne.update.$setOnInsert.companyPageId)).toBe(String(pageId));
    }
  });

  it('a personal post stamps a null companyPageId', async () => {
    networkService.listFollowerIds = vi.fn().mockResolvedValue([String(followerB)]);
    await build().process(
      job({
        postId: String(new Types.ObjectId()),
        authorId: String(author),
        postedAt: new Date().toISOString(),
      }),
    );
    const ops = feedEntryModel.bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$setOnInsert.companyPageId).toBeNull();
    expect(networkService.listCompanyPageFollowerIds).not.toHaveBeenCalled();
  });

  // ── backfill ─────────────────────────────────────────────────────────────
  it('backfill copies the author’s recent posts into the owner feed', async () => {
    const owner = new Types.ObjectId();
    const p1 = { _id: new Types.ObjectId(), createdAt: new Date('2026-05-01') };
    const p2 = { _id: new Types.ObjectId(), createdAt: new Date('2026-05-02') };
    postModel.find = vi.fn(() => postFindChain([p2, p1]));
    feedEntryModel.bulkWrite = vi.fn().mockResolvedValue({ upsertedCount: 2 });

    await build().process(
      job({ kind: 'backfill', ownerId: String(owner), authorId: String(author) }),
    );

    expect(postModel.find).toHaveBeenCalledWith({ authorId: expect.anything(), deletedAt: null });
    expect(networkService.listFollowerIds).not.toHaveBeenCalled();
    const ops = feedEntryModel.bulkWrite.mock.calls[0][0];
    expect(ops.length).toBe(2);
    for (const o of ops) {
      expect(String(o.updateOne.filter.ownerId)).toBe(String(owner));
      expect(String(o.updateOne.update.$setOnInsert.authorId)).toBe(String(author));
      expect(o.updateOne.upsert).toBe(true);
    }
  });

  it('backfill with no posts writes nothing', async () => {
    postModel.find = vi.fn(() => postFindChain([]));
    await build().process(
      job({ kind: 'backfill', ownerId: String(new Types.ObjectId()), authorId: String(author) }),
    );
    expect(feedEntryModel.bulkWrite).not.toHaveBeenCalled();
  });
});
