/**
 * Phase 17 / FIN-16-05 D-31 — GreetingsDispatchLog.
 *
 * One row per (attempted) greeting dispatch. Unique compound index on
 * (workspaceId, partyId, contactId, occasion, todayDate) enforces calendar-day
 * dedupe — a same-day cron re-run hits the unique index and returns E11000
 * which the dispatcher swallows as "already processed".
 *
 * Distinct from ReminderLog (audit row written by F-08 dispatcher on
 * successful send). GreetingsDispatchLog is the dedupe-truth for the cron;
 * ReminderLog is the audit-truth for the channel adapter.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ collection: 'greetingsdispatchlog', timestamps: true })
export class GreetingsDispatchLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

  /** _id of the embedded `party.contacts[]` subdoc. */
  @Prop({ type: Types.ObjectId, required: true })
  contactId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ['birthday', 'anniversary'],
  })
  occasion: 'birthday' | 'anniversary';

  /** 'YYYY-MM-DD' in the workspace's local timezone (D-31 dedupe key). */
  @Prop({ type: String, required: true })
  todayDate: string;

  @Prop({
    type: String,
    required: true,
    enum: ['whatsapp', 'email', 'sms'],
  })
  channel: 'whatsapp' | 'email' | 'sms';

  @Prop({
    type: String,
    required: true,
    enum: ['sent', 'failed'],
  })
  status: 'sent' | 'failed';

  @Prop({ type: String })
  error?: string;

  /** Free-form payload (template language, recipient mask, messageId). */
  @Prop({ type: Object })
  meta?: Record<string, unknown>;
}

export const GreetingsDispatchLogSchema = SchemaFactory.createForClass(
  GreetingsDispatchLog,
);

// D-31 dedupe primary index — UNIQUE on the calendar-day key.
GreetingsDispatchLogSchema.index(
  {
    workspaceId: 1,
    partyId: 1,
    contactId: 1,
    occasion: 1,
    todayDate: 1,
  },
  { unique: true },
);

// Read path: upcoming-greetings preview & status reporting.
GreetingsDispatchLogSchema.index({ workspaceId: 1, todayDate: -1 });
