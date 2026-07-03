import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  INBOX_BODY_MAX,
  INBOX_MESSAGE_KINDS,
  INBOX_SCAN_STATUSES,
  type InboxMessageKind,
  type InboxScanStatus,
} from '../inbox.constants';

/**
 * ManekHR Connect -- a `Message` in a thread (Phase 7 -- Inbox).
 *
 * The durable source of truth. The WebSocket only accelerates delivery; this
 * row is the contract. Two invariants make it correct + scalable:
 *
 *   - `seq` -- a server-assigned per-thread monotonic sequence (allocated by an
 *     atomic `$inc` on `Thread.messageSeq`). It is the sort key (immune to
 *     clock skew), the keyset cursor, and the since-cursor catch-up key.
 *   - `clientMsgId` -- a client-generated UUID, UNIQUE per thread. A retried /
 *     double-tapped send hits the unique index (E11000) and returns the
 *     already-persisted row, so at-least-once delivery never duplicates a line.
 *
 * Media carries URLs only (the upload service returns them) -- never bytes in
 * Mongo, so message docs stay tiny.
 */
@Schema({ _id: false })
export class MessageMedia {
  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String, required: true })
  mime: string;

  @Prop({ type: Number, default: null })
  width: number | null;

  @Prop({ type: Number, default: null })
  height: number | null;

  @Prop({ type: Number, default: null })
  sizeBytes: number | null;

  /** AV / content-scan lifecycle (worker flips it; UI blurs non-clean). */
  @Prop({ type: String, enum: INBOX_SCAN_STATUSES, default: 'pending' })
  scanStatus: InboxScanStatus;
}
export const MessageMediaSchema = SchemaFactory.createForClass(MessageMedia);

@Schema({ timestamps: true, collection: 'connect_messages' })
export class Message extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Thread', required: true })
  threadId: Types.ObjectId;

  /** `null` for a system message (platform-authored, no sender). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  senderUserId: Types.ObjectId | null;

  @Prop({ type: String, enum: INBOX_MESSAGE_KINDS, default: 'text' })
  kind: InboxMessageKind;

  /** Per-thread monotonic ordering key (from `Thread.messageSeq` at send). */
  @Prop({ type: Number, required: true })
  seq: number;

  @Prop({ type: String, trim: true, maxlength: INBOX_BODY_MAX, default: '' })
  body: string;

  /** Photo attachments (URLs only). */
  @Prop({ type: [MessageMediaSchema], default: [] })
  media: MessageMedia[];

  /** Voice note URL (reuses the `connect-audio` / `connect-inbox-media` upload). */
  @Prop({ type: String, default: null })
  audioUrl: string | null;

  @Prop({ type: Number, default: null })
  audioDurationSec: number | null;

  /** Client-generated idempotency key, unique per thread. */
  @Prop({ type: String, required: true })
  clientMsgId: string;

  /** Per-message read receipt (0 or 1 ids in 1:1; array for group later). */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  seenBy: Types.ObjectId[];

  @Prop({ type: Date, default: null })
  editedAt: Date | null;

  /** Soft delete -- body cleared, kind kept, row retained as a tombstone. */
  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type MessageDocument = Message & Document;
export const MessageSchema = SchemaFactory.createForClass(Message);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// (b) Page messages in a thread, stable order + keyset cursor (`seq < before`).
MessageSchema.index({ threadId: 1, seq: -1 });
// Idempotent send -- a retried `clientMsgId` hits E11000 -> return existing.
MessageSchema.index({ threadId: 1, clientMsgId: 1 }, { unique: true });
// Media-scan sweeper picks up un-scanned attachments (partial: pending only).
MessageSchema.index(
  { 'media.scanStatus': 1 },
  { partialFilterExpression: { 'media.scanStatus': 'pending' } },
);
