/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing NetworkService so the transitive
// schema imports (ConnectionRequest/Connection/Follow and their `User` ref)
// don't trip SchemaFactory's reflection. NetworkService never touches Mongoose
// directly — every Model is injected here as a plain mock. Mirrors
// `connect/profile/__tests__/erp-link.service.vitest.ts`.
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
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NetworkService } from '../network.service';

/**
 * Unit coverage for `NetworkService` — the Phase 2 professional-graph
 * mechanics. Verifies the connection-request guards (self / already-connected /
 * duplicate-pending), the accept → `Connection` creation with a sorted pair,
 * recipient/sender authorization, follow idempotency, and the read paths
 * (mutual connections, counts). All three Models are mocked — no MongoDB.
 */

/**
 * A Mongoose query-builder chain whose every step returns itself and whose
 * `.exec()` resolves the given result — covers `findOne` / `find` / `findById`
 * / `deleteOne` / `countDocuments`, all of which the service ends with `.exec()`.
 */
function chain(result: unknown) {
  const c: any = {
    select: vi.fn(() => c),
    sort: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

/** A fresh model mock — empty defaults; tests override per scenario. */
function makeModel() {
  return {
    findOne: vi.fn(() => chain(null)),
    findById: vi.fn(() => chain(null)),
    find: vi.fn(() => chain([])),
    create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    // Atomic follow upsert (ensureFollow). Default = a freshly-inserted edge
    // (updatedExisting:false ⇒ created). Tests override for the matched case.
    findOneAndUpdate: vi.fn(() =>
      chain({ value: { _id: new Types.ObjectId() }, lastErrorObject: { updatedExisting: false } }),
    ),
    deleteOne: vi.fn(() => chain({ deletedCount: 0 })),
    countDocuments: vi.fn(() => chain(0)),
  };
}

describe('NetworkService — Connect professional-graph mechanics (Phase 2)', () => {
  let requestModel: any;
  let connectionModel: any;
  let followModel: any;
  // Captured from the most recent `build()` so the dispatch-wiring tests can
  // assert on the central notification pipeline (Phase 7a).
  let notifications: any;
  // BullMQ feed-fanout queue mock — accept enqueues backfill jobs (Phase 7b).
  let feedQueue: any;
  // User model — backs the demo↔real cross-gate. Default `find` -> [] (no demo
  // rows resolved => both parties treated as real => gate is inert), so the
  // pre-existing graph-mechanics assertions are unaffected.
  let userModel: any;

  const userA = new Types.ObjectId();
  const userB = new Types.ObjectId();

  function build() {
    // Phase 7a — NotificationsService injected as the 4th arg. Stub swallows
    // every dispatch so the existing assertions stay focused on graph mutation
    // semantics (idempotency, guard violations, status transitions).
    notifications = { dispatch: vi.fn(() => Promise.resolve(undefined)) } as any;
    return new NetworkService(
      requestModel,
      connectionModel,
      followModel,
      userModel,
      notifications,
      feedQueue,
    );
  }

  beforeEach(() => {
    requestModel = makeModel();
    connectionModel = makeModel();
    followModel = makeModel();
    userModel = makeModel();
    feedQueue = { add: vi.fn(() => Promise.resolve()) };
  });

  // ── sendRequest ─────────────────────────────────────────────────────────
  it('rejects a connection request to yourself', async () => {
    await expect(build().sendRequest(userA, userA)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a request when the pair is already connected', async () => {
    connectionModel.findOne = vi.fn(() => chain({ _id: new Types.ObjectId() }));
    await expect(build().sendRequest(userA, userB)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate pending request', async () => {
    connectionModel.findOne = vi.fn(() => chain(null)); // not connected
    requestModel.findOne = vi.fn(() => chain({ _id: new Types.ObjectId() })); // pending exists
    await expect(build().sendRequest(userA, userB)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a pending request when the pair is clear (note trimmed)', async () => {
    connectionModel.findOne = vi.fn(() => chain(null));
    requestModel.findOne = vi.fn(() => chain(null));
    requestModel.create = vi
      .fn()
      .mockResolvedValue({ _id: new Types.ObjectId(), status: 'pending' });

    await build().sendRequest(userA, userB, '  hello  ');

    expect(requestModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', note: 'hello' }),
    );
  });

  // ── demo isolation (cross-gate) ─────────────────────────────────────────
  it('blocks a connection request from a real user to a demo account', async () => {
    connectionModel.findOne = vi.fn(() => chain(null));
    requestModel.findOne = vi.fn(() => chain(null));
    // userA real (no row / no flag), userB demo.
    userModel.find = vi.fn(() => chain([{ _id: userB, isDemo: true }]));
    await expect(build().sendRequest(userA, userB)).rejects.toBeInstanceOf(ForbiddenException);
    expect(requestModel.create).not.toHaveBeenCalled();
  });

  it('blocks a connection request from a demo account to a real user (by demo email)', async () => {
    connectionModel.findOne = vi.fn(() => chain(null));
    requestModel.findOne = vi.fn(() => chain(null));
    userModel.find = vi.fn(() => chain([{ _id: userA, email: 'seed1@connect-demo.zari360.test' }]));
    await expect(build().sendRequest(userA, userB)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a connection request between two demo accounts', async () => {
    connectionModel.findOne = vi.fn(() => chain(null));
    requestModel.findOne = vi.fn(() => chain(null));
    requestModel.create = vi
      .fn()
      .mockResolvedValue({ _id: new Types.ObjectId(), status: 'pending' });
    userModel.find = vi.fn(() =>
      chain([
        { _id: userA, isDemo: true },
        { _id: userB, isDemo: true },
      ]),
    );
    await build().sendRequest(userA, userB);
    expect(requestModel.create).toHaveBeenCalled();
  });

  it('blocks a follow between a real user and a demo account', async () => {
    userModel.find = vi.fn(() => chain([{ _id: userB, isDemo: true }]));
    await expect(build().followUser(userA, String(userB))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(followModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // ── respondToRequest ────────────────────────────────────────────────────
  function fakeRequest(over: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(),
      fromUserId: userA,
      toUserId: userB,
      status: 'pending' as string,
      respondedAt: null as Date | null,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  it('rejects a response from someone who is not the recipient', async () => {
    requestModel.findById = vi.fn(() => chain(fakeRequest()));
    // userA is the SENDER, not the recipient → Forbidden.
    await expect(
      build().respondToRequest(userA, new Types.ObjectId().toHexString(), 'accept'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects responding to an already-answered request', async () => {
    requestModel.findById = vi.fn(() => chain(fakeRequest({ status: 'accepted' })));
    await expect(
      build().respondToRequest(userB, new Types.ObjectId().toHexString(), 'accept'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accept → marks the request accepted and creates the Connection as a sorted pair', async () => {
    const doc = fakeRequest();
    requestModel.findById = vi.fn(() => chain(doc));
    connectionModel.findOne = vi.fn(() => chain(null)); // no existing connection

    await build().respondToRequest(userB, new Types.ObjectId().toHexString(), 'accept');

    expect(doc.status).toBe('accepted');
    expect(doc.save).toHaveBeenCalled();
    expect(connectionModel.create).toHaveBeenCalled();
    const arg = connectionModel.create.mock.calls[0][0];
    expect(arg.userA.toHexString() <= arg.userB.toHexString()).toBe(true);
  });

  it('ignore → marks the request ignored and creates no Connection', async () => {
    const doc = fakeRequest();
    requestModel.findById = vi.fn(() => chain(doc));

    await build().respondToRequest(userB, new Types.ObjectId().toHexString(), 'ignore');

    expect(doc.status).toBe('ignored');
    expect(connectionModel.create).not.toHaveBeenCalled();
  });

  // ── respondToRequest → notification dispatch (Phase 7a regression) ───────
  // Locks the bug the owner reported: accepting a request must notify the
  // ORIGINAL SENDER. The notify is fire-and-forget (`void this.notify`) but it
  // invokes `dispatch` synchronously before its first await, so the call is
  // observable the moment `respondToRequest` resolves.
  it('accept → dispatches connect.connection_accepted to the original sender', async () => {
    // fromUserId = userA (sender), toUserId = userB (recipient/accepter).
    const doc = fakeRequest({ fromUserId: userA, toUserId: userB });
    requestModel.findById = vi.fn(() => chain(doc));
    connectionModel.findOne = vi.fn(() => chain(null));

    const service = build();
    await service.respondToRequest(userB, new Types.ObjectId().toHexString(), 'accept');

    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    const arg = notifications.dispatch.mock.calls[0][0];
    expect(arg.category).toBe('connect.connection_accepted');
    // Recipient of the notification is the original requester (userA), NOT the
    // accepter — this is the exact regression the owner hit.
    expect(String(arg.recipientId)).toBe(String(userA));
    expect(String(arg.actorId)).toBe(String(userB));
    expect(arg.entityType).toBe('ConnectionRequest');
  });

  it('accept → creates a SILENT mutual follow (no separate connect.followed)', async () => {
    // Connect implies a mutual follow so connected members see each other's
    // posts — but it must NOT double-notify. fromUserId/toUserId are distinct.
    const doc = fakeRequest({ fromUserId: userA, toUserId: userB });
    requestModel.findById = vi.fn(() => chain(doc));
    connectionModel.findOne = vi.fn(() => chain(null)); // no existing connection
    // followModel.findOneAndUpdate defaults to a created edge → both directions upsert.
    const service = build();
    await service.respondToRequest(userB, new Types.ObjectId().toHexString(), 'accept');

    // Mutual follow — both directions persisted via atomic upsert.
    expect(followModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    // Exactly ONE notification, and it is connection_accepted — the implied
    // follow stays silent (no connect.followed on top).
    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    expect(notifications.dispatch.mock.calls[0][0].category).toBe('connect.connection_accepted');
  });

  it('accept → enqueues two feed-backfill jobs (one per direction)', async () => {
    // Write-time fan-out misses posts made BEFORE the connection; backfill
    // copies each peer's recent posts into the other's feed on accept.
    const doc = fakeRequest({ fromUserId: userA, toUserId: userB });
    requestModel.findById = vi.fn(() => chain(doc));
    connectionModel.findOne = vi.fn(() => chain(null));

    await build().respondToRequest(userB, new Types.ObjectId().toHexString(), 'accept');

    expect(feedQueue.add).toHaveBeenCalledTimes(2);
    const payloads = feedQueue.add.mock.calls.map((c: any[]) => c[1]);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        kind: 'backfill',
        ownerId: String(userA),
        authorId: String(userB),
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        kind: 'backfill',
        ownerId: String(userB),
        authorId: String(userA),
      }),
    );
  });

  it('ignore → dispatches no notification', async () => {
    const doc = fakeRequest({ fromUserId: userA, toUserId: userB });
    requestModel.findById = vi.fn(() => chain(doc));

    const service = build();
    await service.respondToRequest(userB, new Types.ObjectId().toHexString(), 'ignore');

    expect(notifications.dispatch).not.toHaveBeenCalled();
  });

  // ── withdrawRequest ─────────────────────────────────────────────────────
  it('rejects a withdraw from someone who is not the sender', async () => {
    requestModel.findById = vi.fn(() => chain(fakeRequest()));
    // userB is the RECIPIENT, not the sender → Forbidden.
    await expect(
      build().withdrawRequest(userB, new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── follow ──────────────────────────────────────────────────────────────
  it('rejects following yourself', async () => {
    await expect(build().followUser(userA, userA.toHexString())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('follow is idempotent — an existing edge is returned via atomic upsert, no duplicate', async () => {
    const existing = { _id: new Types.ObjectId() };
    // Matched (not upserted) ⇒ updatedExisting:true ⇒ followUser returns the
    // existing edge and stays silent (no connect.followed).
    followModel.findOneAndUpdate = vi.fn(() =>
      chain({ value: existing, lastErrorObject: { updatedExisting: true } }),
    );

    const result = await build().followUser(userA, userB.toHexString());

    expect(result).toBe(existing);
    expect(followModel.create).not.toHaveBeenCalled();
  });

  // ── company page follows ─────────────────────────────────────────────────
  it('followCompanyPage rejects following your own page', async () => {
    const pageId = new Types.ObjectId();
    // follower === ownerUserId → self-follow.
    await expect(
      build().followCompanyPage(userA, pageId.toHexString(), userA),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('followCompanyPage upserts a companyPage edge and notifies the owner on a new follow', async () => {
    const pageId = new Types.ObjectId();
    const owner = userB;
    followModel.findOneAndUpdate = vi.fn(() =>
      chain({ value: { _id: new Types.ObjectId() }, lastErrorObject: { updatedExisting: false } }),
    );

    await build().followCompanyPage(userA, pageId.toHexString(), owner);

    const filter = followModel.findOneAndUpdate.mock.calls[0][0];
    expect(filter.followeeType).toBe('companyPage');
    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    const arg = notifications.dispatch.mock.calls[0][0];
    expect(arg.category).toBe('connect.page_followed');
    expect(String(arg.recipientId)).toBe(String(owner));
  });

  it('followCompanyPage stays silent when the edge already existed', async () => {
    const pageId = new Types.ObjectId();
    followModel.findOneAndUpdate = vi.fn(() =>
      chain({ value: { _id: new Types.ObjectId() }, lastErrorObject: { updatedExisting: true } }),
    );
    await build().followCompanyPage(userA, pageId.toHexString(), userB);
    expect(notifications.dispatch).not.toHaveBeenCalled();
  });

  it('unfollowCompanyPage 404s when not following', async () => {
    followModel.deleteOne = vi.fn(() => chain({ deletedCount: 0 }));
    await expect(
      build().unfollowCompanyPage(userA, new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('isFollowingCompanyPage reflects edge presence', async () => {
    followModel.findOne = vi.fn(() => chain({ _id: new Types.ObjectId() }));
    expect(await build().isFollowingCompanyPage(userA, new Types.ObjectId().toHexString())).toBe(
      true,
    );
    followModel.findOne = vi.fn(() => chain(null));
    expect(await build().isFollowingCompanyPage(userA, new Types.ObjectId().toHexString())).toBe(
      false,
    );
  });

  // ── removeConnection ────────────────────────────────────────────────────
  it('removeConnection 404s when no connection exists', async () => {
    connectionModel.deleteOne = vi.fn(() => chain({ deletedCount: 0 }));
    await expect(build().removeConnection(userA, userB.toHexString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── mutualConnections ───────────────────────────────────────────────────
  it('mutualConnections returns the intersection of the two connection sets', async () => {
    const shared = new Types.ObjectId();
    const viewerOnly = new Types.ObjectId();
    const targetOnly = new Types.ObjectId();
    // viewer (userA) connections: shared + viewerOnly; target (userB): shared + targetOnly.
    connectionModel.find = vi
      .fn()
      .mockReturnValueOnce(
        chain([
          { userA, userB: shared },
          { userA, userB: viewerOnly },
        ]),
      )
      .mockReturnValueOnce(
        chain([
          { userA: userB, userB: shared },
          { userA: userB, userB: targetOnly },
        ]),
      );

    const result = await build().mutualConnections(userA, userB);

    expect(result.count).toBe(1);
    expect(result.userIds).toEqual([String(shared)]);
  });

  // ── getCounts ───────────────────────────────────────────────────────────
  it('getCounts returns pending-request / connection / following / follower counts', async () => {
    requestModel.countDocuments = vi.fn(() => chain(3));
    connectionModel.countDocuments = vi.fn(() => chain(7));
    // following + followers both query followModel.countDocuments → same mock.
    followModel.countDocuments = vi.fn(() => chain(12));

    const result = await build().getCounts(userA);

    expect(result).toEqual({ pendingRequests: 3, connections: 7, following: 12, followers: 12 });
  });

  it('getPublicProfileCounts returns connections + followers for a target', async () => {
    connectionModel.countDocuments = vi.fn(() => chain(5));
    followModel.countDocuments = vi.fn(() => chain(9));

    const result = await build().getPublicProfileCounts(userB);

    expect(result).toEqual({ connections: 5, followers: 9 });
  });

  // ── company page followers (fan-out audience) ─────────────────────────────
  it('listCompanyPageFollowerIds queries followeeType companyPage and maps follower ids', async () => {
    const pageId = new Types.ObjectId();
    const f1 = new Types.ObjectId();
    const f2 = new Types.ObjectId();
    followModel.find = vi.fn(() => chain([{ followerId: f1 }, { followerId: f2 }]));

    const ids = await build().listCompanyPageFollowerIds(pageId);

    expect(followModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ followeeType: 'companyPage' }),
    );
    expect(ids).toEqual([String(f1), String(f2)]);
  });
});
