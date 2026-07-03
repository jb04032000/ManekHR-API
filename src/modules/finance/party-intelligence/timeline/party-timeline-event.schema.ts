/**
 * Phase 17 / FIN-16-03 — Party CRM Timeline event schema.
 *
 * Append-only event-sourced collection (D-15). Voucher / payment / reminder /
 * cron services emit `party.timeline` via EventEmitter2; the Wave-1 subscriber
 * persists rows here.
 *
 * Indexes:
 *   1. { workspaceId, partyId, occurredAt: -1 } — primary read path (timeline
 *      tab on party detail).
 *   2. { workspaceId, firmId, occurredAt: -1 } — workspace-wide feed.
 *   3. partial-unique { refModel, refId, type } — backfill idempotency (D-18).
 *      Allows arbitrary `note.added` / `call.logged` rows (no refId), but
 *      prevents duplicates when re-running backfill against the same voucher.
 *
 * ALL @Prop have explicit { type } per CLAUDE.md/STATE.md rule (Mongoose
 * autocast safety net).
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, SchemaTypes } from 'mongoose';

/** D-16 locked v1 enum — additions require migration note. */
export const PARTY_TIMELINE_EVENT_TYPES = [
  'invoice.created',
  'invoice.paid',
  'payment.received',
  'payment.sent',
  'credit_note.created',
  'debit_note.created',
  'reminder.sent',
  'call.logged',
  'email.logged',
  'note.added',
  'segment.changed',
  'gstin.flag_changed',
  'greeting.sent',
] as const;

export type PartyTimelineEventType = (typeof PARTY_TIMELINE_EVENT_TYPES)[number];

@Schema({
  collection: 'partytimelineevents',
  timestamps: { createdAt: true, updatedAt: false },
})
export class PartyTimelineEvent extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: PARTY_TIMELINE_EVENT_TYPES,
  })
  type: PartyTimelineEventType;

  /** Source voucher model name (e.g. 'SaleInvoice', 'PaymentIn'). Optional for manual entries. */
  @Prop({ type: String })
  refModel?: string;

  /** Source voucher _id. Optional for manual entries. */
  @Prop({ type: Types.ObjectId })
  refId?: Types.ObjectId;

  /** Business-time of the event (voucher date for invoices, sentAt for reminders, etc.). */
  @Prop({ type: Date, required: true })
  occurredAt: Date;

  /** User who triggered the event. Null for system-emitted events (cron, subscriber). */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  actorUserId?: Types.ObjectId;

  /** Human-readable single-line summary (D-16 templates). */
  @Prop({ type: String, required: true })
  summary: string;

  /** Free-form payload for type-specific fields (voucherNumber, amountPaise, channel, etc.). */
  @Prop({ type: SchemaTypes.Mixed })
  meta?: Record<string, unknown>;

  /** Set by timestamps option above; declared for typing only. */
  createdAt?: Date;
}

export const PartyTimelineEventSchema =
  SchemaFactory.createForClass(PartyTimelineEvent);

// 1. Primary read path: party-detail timeline (reverse-chrono).
PartyTimelineEventSchema.index({
  workspaceId: 1,
  partyId: 1,
  occurredAt: -1,
});

// 2. Workspace feed (cross-party recent activity).
PartyTimelineEventSchema.index({
  workspaceId: 1,
  firmId: 1,
  occurredAt: -1,
});

// 3. Backfill idempotency (D-18) — only enforced when refModel+refId both present.
//    `type` is part of the key because a single voucher can emit both
//    `invoice.created` and (later) `invoice.paid` rows.
PartyTimelineEventSchema.index(
  { refModel: 1, refId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      refModel: { $exists: true },
      refId: { $exists: true },
    },
  },
);
