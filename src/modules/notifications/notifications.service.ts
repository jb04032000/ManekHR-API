import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { Notification } from './schemas/notification.schema';
import { CreateNotificationDto } from './dto/notification.dto';
import type { NotificationCategory } from './notification-categories';
import { USER_TOGGLEABLE_CATEGORIES, BELL_HIDDEN_CATEGORIES } from './notification-categories';
import { NotificationPreferencesService } from './notification-preferences.service';
import { InPlatformChannel } from './channels/in-platform.channel';
import { MobilePushChannel } from './channels/mobile-push.channel';
import { BrowserPushChannel } from './channels/browser-push.channel';
import type {
  ChannelSendInput,
  NotificationChannel,
} from './channels/notification-channel.interface';

/**
 * Input for `NotificationsService.dispatch` — central entry for every
 * notification the platform emits.
 */
export interface DispatchInput {
  recipientId: string | Types.ObjectId;
  category: NotificationCategory;
  title: string;
  message: string;
  /** Who triggered the event. `null` for system events. */
  actorId?: string | Types.ObjectId | null;
  /** Domain entity reference (Post / ConnectionRequest / etc.). */
  entityType?: string | null;
  entityId?: string | null;
  /** Workspace context — leave undefined for cross-tenant Connect events. */
  workspaceId?: string | Types.ObjectId | null;
  /** Category-specific payload kept on the row for FE routing / display. */
  metadata?: Record<string, unknown>;
  /** Optional severity. */
  type?: 'info' | 'warning' | 'success' | 'error';
  /**
   * Batching copy (§12.3). When this dispatch folds into an existing unread
   * same-recipient/category/entity row, the row's `message` is rewritten to
   * `batchMessage(count)` (e.g. "3 people reacted to your post."). Category
   * phrasing stays with the caller; the dispatcher stays generic. Omit for
   * non-batchable categories.
   */
  batchMessage?: (count: number) => string;
}

/** Categories that collapse same-recipient + same-entity events into one
 *  unread row (§12.3 batching). Connect post-engagement only - invites,
 *  connection requests, and 1:1 social events never batch. */
const BATCHABLE_CATEGORIES: ReadonlySet<NotificationCategory> = new Set<NotificationCategory>([
  'connect.post_reacted',
  'connect.post_commented',
  'connect.post_reposted',
  'connect.post_replied',
  'connect.post_mentioned',
]);

/** Connect notifications self-prune after this window via the `expiresAt` TTL
 *  index; ERP notifications keep a null `expiresAt` (never auto-expire). */
const CONNECT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** A Mongo duplicate-key error (E11000), used to detect a lost upsert race on
 *  the partial unique `batchKey` index. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** Channel registry — populated in constructor. Order = dispatch order. */
  private readonly channels: NotificationChannel[];

  constructor(
    @InjectModel(Notification.name)
    private notificationModel: Model<Notification>,
    private readonly preferencesService: NotificationPreferencesService,
    private readonly inPlatformChannel: InPlatformChannel,
    private readonly mobilePushChannel: MobilePushChannel,
    private readonly browserPushChannel: BrowserPushChannel,
  ) {
    this.channels = [this.inPlatformChannel, this.mobilePushChannel, this.browserPushChannel];
  }

  /**
   * Central dispatch — every Connect notification emit funnels through here.
   *
   * Pipeline:
   *  1. Persist a single `Notification` envelope (one row regardless of how
   *     many channels fire).
   *  2. For each registered channel: check `isAvailable` + the recipient's
   *     per-channel preference → call `channel.send` with the envelope.
   *  3. Track successful channels in `deliveredChannels` (audit trail).
   *  4. Per-channel error is logged + Sentry-captured but does NOT block
   *     other channels or roll back the persisted row.
   *
   * Returns the persisted Notification doc.
   */
  async dispatch(input: DispatchInput): Promise<Notification> {
    const recipientObjectId = this.toObjectId(input.recipientId);
    const actorObjectId = input.actorId ? this.toObjectId(input.actorId) : null;
    const workspaceObjectId = input.workspaceId ? this.toObjectId(input.workspaceId) : null;

    // Connect rows self-prune via the TTL index; ERP rows never expire.
    const expiresAt = input.category.startsWith('connect.')
      ? new Date(Date.now() + CONNECT_RETENTION_MS)
      : null;
    // Product stamp (one engine, two inboxes): Connect events vs ERP/workspace.
    const product: 'connect' | 'erp' = input.category.startsWith('connect.') ? 'connect' : 'erp';

    // Batching (§12.3): a same-recipient + same-category + same-entity event
    // folds into the existing UNREAD row for that target - accumulate the actor,
    // bump the count, re-light the badge - instead of stacking N near-identical
    // rows. A partial unique index on `batchKey` makes the fold atomic (no
    // duplicate rows under concurrency). Only the Connect post-engagement
    // categories batch, and only with both an actor and a target entity.
    const canBatch =
      actorObjectId !== null &&
      typeof input.entityId === 'string' &&
      input.entityId.length > 0 &&
      BATCHABLE_CATEGORIES.has(input.category);

    let persisted: Notification;
    let aggregatedCount = 1;

    if (canBatch && actorObjectId) {
      const batchKey = `${String(recipientObjectId)}:${input.category}:${input.entityId}`;
      persisted = await this.upsertBatchedNotification(
        input,
        recipientObjectId,
        actorObjectId,
        workspaceObjectId,
        batchKey,
        expiresAt,
      );
      aggregatedCount = persisted.aggregatedCount ?? 1;
    } else {
      persisted = await this.notificationModel.create({
        workspaceId: workspaceObjectId,
        recipientId: recipientObjectId,
        actorId: actorObjectId,
        actorIds: actorObjectId ? [actorObjectId] : [],
        aggregatedCount: 1,
        category: input.category,
        title: input.title,
        message: input.message,
        type: input.type ?? 'info',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        isRead: false,
        deliveredChannels: [],
        expiresAt,
        product,
        // Legacy compatibility - surface category in metadata too so any legacy
        // reader / FE still keys off `metadata.category` keeps working.
        metadata: { ...(input.metadata ?? {}), category: input.category },
      });
    }

    const sendInput: ChannelSendInput = {
      notificationId: String(persisted._id),
      recipientId: String(recipientObjectId),
      category: input.category,
      title: persisted.title,
      message: persisted.message,
      actorId: actorObjectId ? String(actorObjectId) : null,
      aggregatedCount,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? null,
    };

    const delivered: string[] = [];
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          if (!(await channel.isAvailable(sendInput.recipientId))) return;
          const channelKey = this.channelToPrefKey(channel.name);
          // Skip the preferences check for non-toggleable (operational)
          // categories — in-platform always fires for invite events etc.
          if (USER_TOGGLEABLE_CATEGORIES.includes(input.category)) {
            const enabled = await this.preferencesService.isChannelEnabled(
              sendInput.recipientId,
              input.category,
              channelKey,
            );
            if (!enabled) return;
          }
          await channel.send(sendInput);
          delivered.push(channel.name);
        } catch (err) {
          this.logger.error(
            `Channel ${channel.name} failed for notification ${sendInput.notificationId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          Sentry.captureException(err, {
            tags: { module: 'notifications', channel: channel.name },
            extra: { notificationId: sendInput.notificationId, category: input.category },
          });
        }
      }),
    );

    if (delivered.length > 0) {
      await this.notificationModel
        .updateOne({ _id: persisted._id }, { $set: { deliveredChannels: delivered } })
        .exec();
    }
    return persisted;
  }

  /**
   * Fold a batchable event into its single UNREAD row (or create it) atomically.
   * The partial unique index on `batchKey` (unread rows only) guarantees one row
   * per key, so concurrent events cannot stack duplicates: the upsert either
   * folds into the existing row or wins the insert; a loser hits a duplicate-key
   * error and retries as a plain fold. A follow-up write reconciles the
   * denormalized `aggregatedCount` + the count-aware `message` (the upsert cannot
   * read the post-`$addToSet` array length in the same operation).
   */
  private async upsertBatchedNotification(
    input: DispatchInput,
    recipientObjectId: Types.ObjectId,
    actorObjectId: Types.ObjectId,
    workspaceObjectId: Types.ObjectId | null,
    batchKey: string,
    expiresAt: Date | null,
  ): Promise<Notification> {
    const product: 'connect' | 'erp' = input.category.startsWith('connect.') ? 'connect' : 'erp';
    const fold = {
      $addToSet: { actorIds: actorObjectId },
      $set: { actorId: actorObjectId, seenAt: null, title: input.title },
    };
    const upsert = {
      ...fold,
      $setOnInsert: {
        recipientId: recipientObjectId,
        workspaceId: workspaceObjectId,
        category: input.category,
        type: input.type ?? 'info',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        batchKey,
        isRead: false,
        deliveredChannels: [],
        message: input.message,
        aggregatedCount: 1,
        expiresAt,
        product,
        metadata: { ...(input.metadata ?? {}), category: input.category },
      },
    };

    let doc: Notification | null;
    try {
      doc = await this.notificationModel
        .findOneAndUpdate({ batchKey, isRead: false }, upsert, { upsert: true, new: true })
        .exec();
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // Lost the insert race - the row exists now, so fold into it.
      doc = await this.notificationModel
        .findOneAndUpdate({ batchKey, isRead: false }, fold, { new: true })
        .exec();
    }
    if (!doc) {
      // Defensive: an upsert always yields a doc. Fall back to a plain insert so
      // the caller still gets a persisted notification.
      return this.notificationModel.create({
        ...upsert.$setOnInsert,
        title: input.title,
        actorId: actorObjectId,
        actorIds: [actorObjectId],
      });
    }

    const count = Array.isArray(doc.actorIds) ? doc.actorIds.length : 1;
    const message = input.batchMessage && count > 1 ? input.batchMessage(count) : doc.message;
    if (doc.aggregatedCount !== count || doc.message !== message) {
      await this.notificationModel
        .updateOne({ _id: doc._id }, { $set: { aggregatedCount: count, message } })
        .exec();
      doc.aggregatedCount = count;
      doc.message = message;
    }
    return doc;
  }

  /** Map channel.name (snake_case) to ChannelPrefs key (camelCase). */
  private channelToPrefKey(
    name: NotificationChannel['name'],
  ): 'inPlatform' | 'mobilePush' | 'browserPush' {
    switch (name) {
      case 'in_platform':
        return 'inPlatform';
      case 'mobile_push':
        return 'mobilePush';
      case 'browser_push':
        return 'browserPush';
    }
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }

  async findAll(workspaceId: string, userId: string, unreadOnly: boolean = false) {
    const filter: any = { workspaceId, recipientId: userId };
    if (unreadOnly) {
      filter.isRead = false;
    }
    return this.notificationModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  // Used internally by other modules
  async createNotification(workspaceId: string, createDto: CreateNotificationDto) {
    const notification = new this.notificationModel({
      ...createDto,
      workspaceId,
    });
    // In real app, also emit via WebSocket here
    return notification.save();
  }

  async markAsRead(workspaceId: string, userId: string, notificationId: string) {
    const notification = await this.notificationModel
      .findOneAndUpdate(
        { _id: notificationId, workspaceId, recipientId: userId },
        { isRead: true },
        { new: true },
      )
      .exec();
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  async markAllAsRead(workspaceId: string, userId: string) {
    await this.notificationModel
      .updateMany({ workspaceId, recipientId: userId, isRead: false }, { $set: { isRead: true } })
      .exec();
    return { message: 'All notifications marked as read' };
  }

  async remove(workspaceId: string, userId: string, notificationId: string) {
    const notification = await this.notificationModel
      .findOneAndDelete({
        _id: notificationId,
        workspaceId,
        recipientId: userId,
      })
      .exec();

    if (!notification) throw new NotFoundException('Notification not found');
  }

  // ── P2.0 (2026-05-14) — cross-workspace user-scoped surface ─────────────
  // Powers the new /me/notifications endpoints in MeNotificationsController.
  // Scopes purely by recipientId so invite notifications (which fire for a
  // workspace the invitee is not yet a member of) reach the bell.

  /**
   * List notifications across all workspaces for a user. Optional filters:
   *   - unreadOnly: only isRead === false
   *   - category:   matches metadata.category (e.g. 'INVITE_RECEIVED')
   *   - limit:      cap on returned rows (default 100, max 200)
   */
  /**
   * Compose a product scope onto a filter ("one engine, two inboxes"). Connect
   * rows are ALWAYS stamped `product: 'connect'` by `dispatch`. ERP rows are
   * stamped `'erp'` (when they flow through `dispatch` with a non-connect
   * category) OR carry a null stamp (the legacy `createNotification` path
   * predates the stamp), so the ERP inbox claims both. If a category `$or`
   * already occupies the top level, the two are AND-ed so neither is lost.
   */
  private scopeByProduct(
    filter: Record<string, unknown>,
    product?: 'connect' | 'erp',
  ): Record<string, unknown> {
    if (product === 'connect') {
      filter.product = 'connect';
    } else if (product === 'erp') {
      const productOr = [{ product: 'erp' }, { product: null }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: productOr }];
        delete filter.$or;
      } else {
        filter.$or = productOr;
      }
    }
    return filter;
  }

  async listForUser(
    userId: string,
    opts: {
      unreadOnly?: boolean;
      category?: string;
      limit?: number;
      before?: string;
      product?: 'connect' | 'erp';
    } = {},
  ) {
    const filter: Record<string, unknown> = {
      recipientId: userId,
      // Messages are surfaced in the inbox (own unread badge) + still
      // browser-push; they are intentionally hidden from the general bell.
      category: { $nin: Array.from(BELL_HIDDEN_CATEGORIES) },
    };
    if (opts.unreadOnly) filter.isRead = false;
    if (opts.category) {
      // Match new first-class `category` OR legacy `metadata.category` so the
      // bell stays consistent during the Phase 7a transition window.
      filter.$or = [{ category: opts.category }, { 'metadata.category': opts.category }];
    }
    // Keyset pagination: `before` is the createdAt of the last row already shown,
    // so the next page is strictly older. Ignored if not a valid date.
    if (opts.before) {
      const cursor = new Date(opts.before);
      if (!Number.isNaN(cursor.getTime())) filter.createdAt = { $lt: cursor };
    }
    // Shell scope ("one engine, two inboxes"): the Connect centre passes
    // `product: 'connect'` so older pages never surface ERP rows.
    this.scopeByProduct(filter, opts.product);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    return this.notificationModel.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  }

  async countUnreadForUser(userId: string, category?: string): Promise<number> {
    const filter: Record<string, unknown> = {
      recipientId: userId,
      isRead: false,
      // Inbox messages are excluded from the bell (they keep their own badge).
      category: { $nin: Array.from(BELL_HIDDEN_CATEGORIES) },
    };
    if (category) {
      filter.$or = [{ category }, { 'metadata.category': category }];
    }
    return this.notificationModel.countDocuments(filter).exec();
  }

  /**
   * Count UNSEEN notifications for the bell badge (two-state model). Unseen =
   * `seenAt == null` — the red count clears the moment the user opens the
   * notification surface, distinct from per-row read state.
   */
  async countUnseenForUser(userId: string): Promise<number> {
    return this.notificationModel
      .countDocuments({
        recipientId: userId,
        seenAt: null,
        // Inbox messages are excluded from the bell badge (own unread badge).
        category: { $nin: Array.from(BELL_HIDDEN_CATEGORIES) },
      })
      .exec();
  }

  /**
   * Mark unseen notifications seen (sets `seenAt = now`). Called when the user
   * opens the bell dropdown / notifications center (no `category` → all), OR
   * when they visit a surface that "owns" a category and should clear just that
   * slice — e.g. opening `/connect/network` clears unseen
   * `connect.connection_accepted` so the network nav badge drops while the bell
   * keeps any other unseen items. Never marks rows read (they stay bold until
   * clicked). Matches both the first-class `category` and legacy
   * `metadata.category` so transition-window rows clear too.
   */
  async markAllSeenForUser(userId: string, category?: string, product?: 'connect' | 'erp') {
    const filter: Record<string, unknown> = { recipientId: userId, seenAt: null };
    if (category) {
      filter.$or = [{ category }, { 'metadata.category': category }];
    }
    // Shell scope: opening the Connect bell clears only Connect unseen rows, so
    // the ERP bell badge is left intact (and vice-versa).
    this.scopeByProduct(filter, product);
    await this.notificationModel.updateMany(filter, { $set: { seenAt: new Date() } }).exec();
    return { message: 'All notifications marked as seen' };
  }

  async markReadForUser(userId: string, notificationId: string) {
    const notification = await this.notificationModel
      .findOneAndUpdate(
        { _id: notificationId, recipientId: userId },
        { isRead: true },
        { new: true },
      )
      .exec();
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  async markAllReadForUser(userId: string, category?: string, product?: 'connect' | 'erp') {
    const filter: Record<string, unknown> = { recipientId: userId, isRead: false };
    // Match first-class `category` OR legacy `metadata.category` (consistent
    // with `markAllSeenForUser` + `listForUser`).
    if (category) filter.$or = [{ category }, { 'metadata.category': category }];
    this.scopeByProduct(filter, product);
    await this.notificationModel.updateMany(filter, { $set: { isRead: true } }).exec();
    return { message: 'All notifications marked as read' };
  }

  /**
   * Delete ONE of the caller's own notifications (recipient-scoped so a user
   * can never delete another user's row). Powers the per-row trash button on
   * the bell + centre.
   */
  async deleteForUser(userId: string, notificationId: string) {
    const deleted = await this.notificationModel
      .findOneAndDelete({ _id: notificationId, recipientId: userId })
      .exec();
    if (!deleted) throw new NotFoundException('Notification not found');
    return { message: 'Notification deleted' };
  }

  /**
   * Clear the caller's notifications, optionally scoped to one product
   * ("one engine, two inboxes"): a Connect "clear all" must not nuke the ERP
   * bell, and vice-versa. No product → clears everything for the user.
   */
  async deleteAllForUser(userId: string, product?: 'connect' | 'erp') {
    const filter = this.scopeByProduct({ recipientId: userId }, product);
    const res = await this.notificationModel.deleteMany(filter).exec();
    return { message: 'Notifications cleared', deletedCount: res.deletedCount ?? 0 };
  }
}
