import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../notification-categories';

/**
 * Persisted notification envelope.
 *
 * Phase 7a (2026-05-21) extended the schema with first-class fields:
 *  - `category` — promoted from `metadata.category`; indexed for fast filter.
 *  - `actorId` — who triggered the event (post reactor, request sender, etc.).
 *  - `entityType` / `entityId` — domain entity reference (Post, ConnectionRequest).
 *  - `deliveredChannels` — audit trail of which channel adapters fanned out.
 *  - `workspaceId` — now OPTIONAL (Connect cross-tenant events have no workspace).
 *
 * The legacy ERP path still passes `workspaceId` + writes the category into
 * `metadata.category` (pre-Phase-7a). Both shapes live side by side; the
 * `listForUser` query filters by `category` first and falls back to
 * `metadata.category` for legacy rows so the bell stays consistent during
 * the transition window.
 */
@Schema({ timestamps: true })
export class Notification extends Document {
  // OPTIONAL — Connect cross-tenant events (connection requests etc.) have
  // no workspace context. ERP notifications keep populating this.
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null, index: true })
  workspaceId: Workspace | Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  recipientId: User | Types.ObjectId;

  /** Who triggered the event. `null` for system-generated notifications.
   *  When a row is batched (see `actorIds`) this holds the LATEST actor,
   *  the one shown as the headline. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  actorId: User | Types.ObjectId | null;

  /**
   * Distinct actors collapsed into this notification (batching, §12.3).
   * Same-recipient + same-category + same-entity events that arrive while
   * this row is still UNREAD and inside the batch window fold into it:
   * each new actor is added here (deduped) and `aggregatedCount` is bumped,
   * so N reactions render as one "N people reacted" row instead of N rows.
   * Empty for a fresh singleton; `actorId` is always the most recent actor.
   */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  actorIds: Types.ObjectId[];

  /** Distinct-actor tally for the batched row (mirrors `actorIds.length`);
   *  `1` for a singleton. Lets the FE render "N people …" with no recompute. */
  @Prop({ type: Number, default: 1 }) aggregatedCount: number;

  /** Deterministic batch key `recipientId:category:entityId`. Set ONLY on
   *  batchable Connect post-engagement rows; null on ERP + 1:1 events (which
   *  never batch). The partial unique index below keys off it to guarantee at
   *  most ONE unread row per key, so `dispatch` folds atomically (race-free). */
  @Prop({ type: String, default: null }) batchKey?: string | null;

  /** Absolute TTL expiry. Set on Connect rows (createdAt + retention window) so
   *  the collection self-prunes; left null on ERP rows, which the TTL index
   *  ignores (a TTL index never expires a doc whose field is not a Date). */
  @Prop({ type: Date, default: null }) expiresAt?: Date | null;

  /** Product stamp - which app this notification belongs to ("one engine, two
   *  inboxes"): Connect events vs ERP / workspace events. The bell, center, and
   *  per-product admin broadcasts filter on it. Null on legacy rows (pre-stamp);
   *  the FE treats a null/absent stamp as `erp` via its category heuristic. */
  @Prop({ type: String, enum: ['connect', 'erp'], default: null })
  product?: 'connect' | 'erp' | null;

  /** Typed category. Drives FE routing + preference filtering. */
  @Prop({ type: String, enum: NOTIFICATION_CATEGORIES, index: true })
  category?: NotificationCategory;

  @Prop({ required: true }) title: string;
  @Prop({ required: true }) message: string;

  @Prop({ enum: ['info', 'warning', 'success', 'error'], default: 'info' })
  type: string;

  // Two-state model (LinkedIn / GitHub):
  //  - `seenAt == null` → UNSEEN. Drives the red bell badge count. Cleared
  //    (set to now) when the user opens the bell dropdown or the
  //    notifications center (`markAllSeenForUser`).
  //  - `isRead == false` → UNREAD. Drives the per-row bold/highlight. Cleared
  //    on a per-row click (`markReadForUser`) or the explicit "mark all read".
  // A notification is born unseen + unread; opening the surface makes it
  // seen (badge clears) but it stays bold until the row itself is clicked.
  @Prop({ type: Date, default: null, index: true }) seenAt?: Date | null;

  @Prop({ default: false, index: true }) isRead: boolean;

  /** Domain entity reference — e.g. `entityType: 'ConnectionRequest'`. */
  @Prop({ type: String, default: null }) entityType?: string | null;
  @Prop({ type: String, default: null }) entityId?: string | null;

  /** Audit trail — which channel adapters successfully fanned out. */
  @Prop({ type: [String], default: [] }) deliveredChannels: string[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- category-specific payload (legacy contract; per-row shape varies)
  @Prop({ type: Object }) metadata: any;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// Compound index for the cross-workspace user list query
// (`listForUser` + `countUnreadForUser` filter on recipientId + isRead,
// sorted by createdAt desc).
NotificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });

// Batching invariant + lookup (§12.3): at most ONE unread row per `batchKey`,
// so `dispatch` folds a same recipient + category + entity event atomically
// (race-free) via an upsert. Partial (batchKey set AND unread only) so ERP
// rows (null batchKey) and already-read rows are exempt and never collide.
NotificationSchema.index(
  { batchKey: 1 },
  { unique: true, partialFilterExpression: { batchKey: { $type: 'string' }, isRead: false } },
);

// Retention: a TTL index auto-purges a row once `expiresAt` passes. Set on
// Connect rows only (createdAt + window); null on ERP rows, which TTL ignores.
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
