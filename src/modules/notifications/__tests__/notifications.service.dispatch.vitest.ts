/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method -- vitest model mocks intentionally any-typed (matches the established connect-vitest convention); unbound-method is a false positive on `expect(channel.send)` assertions against vi.fn mocks */
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing NotificationsService so
// the transitive schema imports (Notification, NotificationPreferences) don't
// trip the "Cannot determine type" reflection error under vitest's esbuild
// transform. We never use Mongoose at runtime here — all Models are mocked.
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

import { NotificationsService } from '../notifications.service';
import type { NotificationChannel } from '../channels/notification-channel.interface';

/**
 * Dispatch pipeline tests — Phase 7a (2026-05-21).
 *
 * Verify the central `dispatch` orchestrator:
 *  - Persists exactly one Notification envelope.
 *  - Honours per-channel preference toggles for user-toggleable categories.
 *  - Skips a channel whose `isAvailable` returns false (no failure counted).
 *  - Isolates per-channel errors — one channel throwing does not block others.
 *  - Records the successful channels in `deliveredChannels`.
 *  - Bypasses preferences for operational (non-toggleable) categories.
 */
describe('NotificationsService.dispatch — central pipeline', () => {
  let notificationModel: any;
  let preferencesService: any;
  let inPlatform: NotificationChannel;
  let mobilePush: NotificationChannel;
  let browserPush: NotificationChannel;

  // The persisted-envelope id the orchestrator writes.
  const persistedId = new Types.ObjectId();

  function build(): NotificationsService {
    // Build the service with mock dependencies. We only stub what the
    // `dispatch` path touches — the rest of the constructor wiring is
    // exercised by the Nest DI at runtime.
    const service = new NotificationsService(
      notificationModel,
      {} as any, // roleModel — unused on dispatch
      {} as any, // memberModel — unused on dispatch
      {} as any, // workspaceModel — unused on dispatch
      preferencesService,
      inPlatform as any,
      mobilePush as any,
      browserPush as any,
    );
    return service;
  }

  beforeEach(() => {
    notificationModel = {
      create: vi.fn(() => Promise.resolve({ _id: persistedId })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
      // Default: the atomic batch upsert returns a freshly-inserted single-actor
      // row (count 1), so the plain create path is reserved for non-batchable.
      findOneAndUpdate: vi.fn(() => ({
        exec: () =>
          Promise.resolve({
            _id: persistedId,
            actorIds: [new Types.ObjectId()],
            aggregatedCount: 1,
            message: 'm',
          }),
      })),
    };
    preferencesService = {
      isChannelEnabled: vi.fn(() => Promise.resolve(true)),
    };
    inPlatform = makeChannel('in_platform');
    mobilePush = makeChannel('mobile_push');
    browserPush = makeChannel('browser_push');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('persists exactly one Notification envelope', async () => {
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      category: 'connect.connection_requested',
      title: 't',
      message: 'm',
    });
    expect(notificationModel.create).toHaveBeenCalledTimes(1);
  });

  it('fires the in-platform channel when its pref + isAvailable allow', async () => {
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      category: 'connect.connection_requested',
      title: 't',
      message: 'm',
    });
    expect(inPlatform.send).toHaveBeenCalledTimes(1);
    // Audit trail recorded the successful channel.
    expect(notificationModel.updateOne).toHaveBeenCalledWith(
      { _id: persistedId },
      { $set: { deliveredChannels: ['in_platform'] } },
    );
  });

  it('skips a channel whose pref is off (toggleable category)', async () => {
    preferencesService.isChannelEnabled = vi.fn((_uid: any, _cat: any, channel: any) =>
      Promise.resolve(channel === 'inPlatform' ? false : true),
    );
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      category: 'connect.connection_requested',
      title: 't',
      message: 'm',
    });
    expect(inPlatform.send).not.toHaveBeenCalled();
    // mobile + browser are unavailable by default (their isAvailable=false)
    // so the deliveredChannels audit stays empty — and the updateOne write
    // never fires (orchestrator skips when delivered.length === 0).
    expect(notificationModel.updateOne).not.toHaveBeenCalled();
  });

  it('skips an unavailable channel without recording a failure', async () => {
    // mobile + browser already default to isAvailable=false from `makeChannel`.
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      category: 'connect.connection_requested',
      title: 't',
      message: 'm',
    });
    expect(mobilePush.send).not.toHaveBeenCalled();
    expect(browserPush.send).not.toHaveBeenCalled();
  });

  it('isolates per-channel errors — one failure does not block others', async () => {
    (inPlatform.send as any).mockRejectedValueOnce(new Error('socket down'));
    // Force mobile push available so it tries to send (and we can verify it
    // ran even after in_platform crashed).
    (mobilePush.isAvailable as any).mockResolvedValue(true);
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      category: 'connect.connection_requested',
      title: 't',
      message: 'm',
    });
    // mobile push got invoked despite in_platform throwing.
    expect(mobilePush.send).toHaveBeenCalledTimes(1);
    // The orchestrator never re-throws — the dispatch promise resolved.
  });

  it('markAllSeenForUser sets seenAt only on unseen rows', async () => {
    const updateMany = vi.fn(() => ({ exec: () => Promise.resolve({}) }));
    notificationModel.updateMany = updateMany;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.markAllSeenForUser(uid);
    expect(updateMany).toHaveBeenCalledWith(
      { recipientId: uid, seenAt: null },
      { $set: { seenAt: expect.any(Date) } },
    );
  });

  it('markAllSeenForUser scopes to one category when given (drops the network badge only)', async () => {
    const updateMany = vi.fn(() => ({ exec: () => Promise.resolve({}) }));
    notificationModel.updateMany = updateMany;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.markAllSeenForUser(uid, 'connect.connection_accepted');
    expect(updateMany).toHaveBeenCalledWith(
      {
        recipientId: uid,
        seenAt: null,
        $or: [
          { category: 'connect.connection_accepted' },
          { 'metadata.category': 'connect.connection_accepted' },
        ],
      },
      { $set: { seenAt: expect.any(Date) } },
    );
  });

  it('countUnseenForUser filters seenAt null', async () => {
    const countDocuments = vi.fn(() => ({ exec: () => Promise.resolve(3) }));
    notificationModel.countDocuments = countDocuments;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    const n = await service.countUnseenForUser(uid);
    expect(n).toBe(3);
    expect(countDocuments).toHaveBeenCalledWith({
      recipientId: uid,
      seenAt: null,
      category: { $nin: ['connect.message_received'] },
    });
  });

  // ── Bell exclusion: connect.message_received lives in the inbox only ──────
  it('listForUser excludes connect.message_received from the bell ($nin)', () => {
    const exec = vi.fn(() => Promise.resolve([]));
    const limit = vi.fn(() => ({ exec }));
    const sort = vi.fn(() => ({ limit }));
    const find = vi.fn(() => ({ sort }));
    notificationModel.find = find;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    void service.listForUser(uid);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: uid,
        category: { $nin: ['connect.message_received'] },
      }),
    );
  });

  it('countUnseenForUser excludes connect.message_received from the bell badge', async () => {
    const countDocuments = vi.fn(() => ({ exec: () => Promise.resolve(0) }));
    notificationModel.countDocuments = countDocuments;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.countUnseenForUser(uid);
    expect(countDocuments).toHaveBeenCalledWith({
      recipientId: uid,
      seenAt: null,
      category: { $nin: ['connect.message_received'] },
    });
  });

  it('countUnreadForUser excludes connect.message_received from the bell', async () => {
    const countDocuments = vi.fn(() => ({ exec: () => Promise.resolve(0) }));
    notificationModel.countDocuments = countDocuments;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.countUnreadForUser(uid);
    expect(countDocuments).toHaveBeenCalledWith({
      recipientId: uid,
      isRead: false,
      category: { $nin: ['connect.message_received'] },
    });
  });

  it('listForUser keeps the ERP product $or AND the bell exclusion both intact', () => {
    const exec = vi.fn(() => Promise.resolve([]));
    const limit = vi.fn(() => ({ exec }));
    const sort = vi.fn(() => ({ limit }));
    const find = vi.fn(() => ({ sort }));
    notificationModel.find = find;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    // ERP product scope wraps the category-$or into $and; the top-level
    // `category: { $nin }` exclusion must survive that composition.
    void service.listForUser(uid, { category: 'INVITE_RECEIVED', product: 'erp' });
    const arg = find.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.category).toEqual({ $nin: ['connect.message_received'] });
    expect(arg.$and).toEqual([
      { $or: [{ category: 'INVITE_RECEIVED' }, { 'metadata.category': 'INVITE_RECEIVED' }] },
      { $or: [{ product: 'erp' }, { product: null }] },
    ]);
  });

  it('bypasses preferences for non-toggleable (operational) categories', async () => {
    // Legacy invite event — not in USER_TOGGLEABLE_CATEGORIES, must still
    // fan out without consulting prefs.
    preferencesService.isChannelEnabled = vi.fn();
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      category: 'INVITE_RECEIVED',
      title: 't',
      message: 'm',
    });
    expect(preferencesService.isChannelEnabled).not.toHaveBeenCalled();
    expect(inPlatform.send).toHaveBeenCalledTimes(1);
  });

  // ── §12.3 batching: collapse same-recipient/category/entity events ───────
  it('folds a batchable event into the existing unread row (no new row)', async () => {
    const existingId = new Types.ObjectId();
    const a1 = new Types.ObjectId();
    const a2 = new Types.ObjectId();
    // The atomic upsert returns the row carrying both actors (count 2).
    notificationModel.findOneAndUpdate = vi.fn(() => ({
      exec: () =>
        Promise.resolve({
          _id: existingId,
          actorIds: [a1, a2],
          aggregatedCount: 1,
          message: 'Liked your post.',
        }),
    }));
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      actorId: a2,
      category: 'connect.post_reacted',
      entityType: 'Post',
      entityId: new Types.ObjectId().toHexString(),
      title: 'New reaction on your post',
      message: 'Liked your post.',
      batchMessage: (count) => `${count} people reacted to your post.`,
    });
    // Atomic upsert used; no fresh create.
    expect(notificationModel.findOneAndUpdate).toHaveBeenCalled();
    expect(notificationModel.create).not.toHaveBeenCalled();
    // Reconcile wrote the bumped count + the count-aware message.
    expect(notificationModel.updateOne).toHaveBeenCalledWith(
      { _id: existingId },
      { $set: { aggregatedCount: 2, message: '2 people reacted to your post.' } },
    );
  });

  it('inserts the batched row via an atomic upsert when none is open', async () => {
    const a1 = new Types.ObjectId();
    notificationModel.findOneAndUpdate = vi.fn(() => ({
      exec: () =>
        Promise.resolve({
          _id: persistedId,
          actorIds: [a1],
          aggregatedCount: 1,
          message: 'Liked your post.',
        }),
    }));
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      actorId: a1,
      category: 'connect.post_reacted',
      entityType: 'Post',
      entityId: new Types.ObjectId().toHexString(),
      title: 'New reaction on your post',
      message: 'Liked your post.',
      batchMessage: (count) => `${count} people reacted to your post.`,
    });
    // Batchable path always goes through the upsert, never the plain create.
    expect(notificationModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ isRead: false }),
      expect.anything(),
      expect.objectContaining({ upsert: true, new: true }),
    );
    expect(notificationModel.create).not.toHaveBeenCalled();
  });

  it('never batches a non-batchable category (connection_requested uses create)', async () => {
    const service = build();
    await service.dispatch({
      recipientId: new Types.ObjectId(),
      actorId: new Types.ObjectId(),
      category: 'connect.connection_requested',
      entityType: 'ConnectionRequest',
      entityId: new Types.ObjectId().toHexString(),
      title: 't',
      message: 'm',
    });
    expect(notificationModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notificationModel.create).toHaveBeenCalledTimes(1);
  });

  // ── Delete (per-row trash + clear-all) ───────────────────────────────────
  it('deleteForUser deletes the caller own row (recipient-scoped)', async () => {
    const findOneAndDelete = vi.fn(() => ({ exec: () => Promise.resolve({ _id: persistedId }) }));
    notificationModel.findOneAndDelete = findOneAndDelete;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    const id = new Types.ObjectId().toHexString();
    await service.deleteForUser(uid, id);
    expect(findOneAndDelete).toHaveBeenCalledWith({ _id: id, recipientId: uid });
  });

  it('deleteForUser throws NotFound when the row is absent (or not the caller)', async () => {
    notificationModel.findOneAndDelete = vi.fn(() => ({ exec: () => Promise.resolve(null) }));
    const service = build();
    await expect(
      service.deleteForUser(new Types.ObjectId().toHexString(), new Types.ObjectId().toHexString()),
    ).rejects.toThrow('Notification not found');
  });

  // ── Product scope ("one engine, two inboxes") ────────────────────────────
  it('deleteAllForUser scopes the wipe to Connect, leaving ERP rows', async () => {
    const deleteMany = vi.fn(() => ({ exec: () => Promise.resolve({ deletedCount: 4 }) }));
    notificationModel.deleteMany = deleteMany;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    const res = await service.deleteAllForUser(uid, 'connect');
    expect(deleteMany).toHaveBeenCalledWith({ recipientId: uid, product: 'connect' });
    expect(res.deletedCount).toBe(4);
  });

  it('deleteAllForUser ERP scope also claims null-stamped legacy rows', async () => {
    const deleteMany = vi.fn(() => ({ exec: () => Promise.resolve({ deletedCount: 1 }) }));
    notificationModel.deleteMany = deleteMany;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.deleteAllForUser(uid, 'erp');
    expect(deleteMany).toHaveBeenCalledWith({
      recipientId: uid,
      $or: [{ product: 'erp' }, { product: null }],
    });
  });

  it('markAllSeenForUser scopes to product (Connect bell leaves ERP unseen intact)', async () => {
    const updateMany = vi.fn(() => ({ exec: () => Promise.resolve({}) }));
    notificationModel.updateMany = updateMany;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.markAllSeenForUser(uid, undefined, 'connect');
    expect(updateMany).toHaveBeenCalledWith(
      { recipientId: uid, seenAt: null, product: 'connect' },
      { $set: { seenAt: expect.any(Date) } },
    );
  });

  it('markAllSeenForUser AND-combines a category $or with the ERP product $or', async () => {
    const updateMany = vi.fn(() => ({ exec: () => Promise.resolve({}) }));
    notificationModel.updateMany = updateMany;
    const service = build();
    const uid = new Types.ObjectId().toHexString();
    await service.markAllSeenForUser(uid, 'INVITE_RECEIVED', 'erp');
    expect(updateMany).toHaveBeenCalledWith(
      {
        recipientId: uid,
        seenAt: null,
        $and: [
          { $or: [{ category: 'INVITE_RECEIVED' }, { 'metadata.category': 'INVITE_RECEIVED' }] },
          { $or: [{ product: 'erp' }, { product: null }] },
        ],
      },
      { $set: { seenAt: expect.any(Date) } },
    );
  });
});

function makeChannel(name: NotificationChannel['name']): NotificationChannel {
  return {
    name,
    // Default: only in_platform is available — the others scaffold to off.
    isAvailable: vi.fn(() => Promise.resolve(name === 'in_platform')),
    send: vi.fn(() => Promise.resolve(undefined)),
  };
}
