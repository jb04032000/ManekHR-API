import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  INBOX_CHANNEL_TYPES,
  INBOX_CONTEXT_ENTITY_TYPES,
  INBOX_MESSAGE_KINDS,
  type InboxChannelType,
  type InboxContextEntityType,
  type InboxMessageKind,
} from '../inbox.constants';

/**
 * ManekHR Connect -- a conversation `Thread` (Phase 7 -- Inbox).
 *
 * A thin envelope over a 1:1 conversation. The message stream lives in
 * `connect_messages`; the thread holds the participant set, the dedup key, the
 * denormalized last-message + per-participant unread state (the Computed
 * pattern, so the inbox list renders with zero joins), and -- for the
 * inquiry / application / quote channels -- a CONTEXT REF to the live entity
 * (never a copy; the context card hydrates the source row at render time).
 *
 * Person-centric: `participantIds` are `User` ids, sorted ascending, length 2
 * in v1. `pairKey` is the deterministic dedup key (the `Connection`
 * canonical-ordered-pair pattern, generalized to carry the channel + context),
 * so a single unique index makes find-or-create idempotent under a race.
 */
@Schema({ _id: false })
export class ThreadLastMessage {
  @Prop({ type: Types.ObjectId, required: true })
  messageId: Types.ObjectId;

  /** `null` for a system message (no sender). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  senderUserId: Types.ObjectId | null;

  /** Trimmed text, or a marker like '[photo]' / '[voice note]'. */
  @Prop({ type: String, default: '' })
  preview: string;

  @Prop({ type: String, enum: INBOX_MESSAGE_KINDS, default: 'text' })
  kind: InboxMessageKind;

  /** The message's per-thread sequence (mirrors `Thread.messageSeq` at send). */
  @Prop({ type: Number, default: 0 })
  seq: number;

  @Prop({ type: Date, default: () => new Date() })
  createdAt: Date;
}
export const ThreadLastMessageSchema = SchemaFactory.createForClass(ThreadLastMessage);

/** Per-participant denormalized state (Computed pattern; one entry per member). */
@Schema({ _id: false })
export class ThreadParticipant {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** Atomic `$inc` on a send to the OTHER participant; reset on read. */
  @Prop({ type: Number, default: 0, min: 0 })
  unreadCount: number;

  /** Highest message `seq` this participant has read (monotonic). */
  @Prop({ type: Number, default: 0 })
  lastReadSeq: number;

  @Prop({ type: Types.ObjectId, default: null })
  lastReadMessageId: Types.ObjectId | null;

  @Prop({ type: Boolean, default: false })
  archived: boolean;

  /** Mutes the notification, NOT the unread count. */
  @Prop({ type: Boolean, default: false })
  muted: boolean;

  @Prop({ type: Date, default: null })
  lastReadAt: Date | null;
}
export const ThreadParticipantSchema = SchemaFactory.createForClass(ThreadParticipant);

@Schema({ timestamps: true, collection: 'connect_threads' })
export class Thread extends Document {
  /** The two `User` participants, sorted ascending (1:1 in v1). */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], required: true })
  participantIds: Types.ObjectId[];

  /**
   * Deterministic dedup key. `dm`: `"<minId>:<maxId>:dm"`. Context channel:
   * `"<minId>:<maxId>:<channelType>:<entityId>"`. System: `"<userId>:system:<topic>"`.
   * UNIQUE -- makes `getOrCreateThread` idempotent under concurrent first-contact.
   */
  @Prop({ type: String, required: true })
  pairKey: string;

  @Prop({ type: String, enum: INBOX_CHANNEL_TYPES, required: true })
  channelType: InboxChannelType;

  /** The wrapped entity type for a context channel; `null` for dm / system. */
  @Prop({ type: String, enum: INBOX_CONTEXT_ENTITY_TYPES, default: null })
  contextEntityType: InboxContextEntityType | null;

  @Prop({ type: Types.ObjectId, default: null })
  contextEntityId: Types.ObjectId | null;

  /** Denormalized for the list row; `null` until the first message. */
  @Prop({ type: ThreadLastMessageSchema, default: null })
  lastMessage: ThreadLastMessage | null;

  /** = lastMessage.createdAt. The thread-list SORT KEY (and keyset cursor). */
  @Prop({ type: Date, default: () => new Date() })
  lastActivityAt: Date;

  /** Server-assigned per-thread monotonic counter; `$inc` allocates each `seq`. */
  @Prop({ type: Number, default: 0 })
  messageSeq: number;

  @Prop({ type: [ThreadParticipantSchema], default: [] })
  participants: ThreadParticipant[];

  /** A context thread can close when its entity resolves (filled job, etc.). */
  @Prop({ type: Boolean, default: false })
  closed: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ThreadDocument = Thread & Document;
export const ThreadSchema = SchemaFactory.createForClass(Thread);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// (a) List my threads newest-first (multikey on the embedded participant ids).
ThreadSchema.index({ 'participants.userId': 1, lastActivityAt: -1 });
// (c) 1:1 / context dedup -- one canonical row per (pair, channel, context).
ThreadSchema.index({ pairKey: 1 }, { unique: true });
// Channel-filtered inbox tabs (DMs vs Inquiries vs Applications vs Quotes vs System).
ThreadSchema.index({ channelType: 1, 'participants.userId': 1, lastActivityAt: -1 });
// Resolve "the thread for this inquiry / application / quote" when opening from
// the source UI. Partial: only context threads carry an entity id.
ThreadSchema.index(
  { contextEntityType: 1, contextEntityId: 1 },
  { partialFilterExpression: { contextEntityId: { $exists: true, $ne: null } } },
);
