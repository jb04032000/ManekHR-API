import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'reminder_logs' })
export class ReminderLog extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  partyId: Types.ObjectId;

  /** Optional — populated for invoice_overdue / invoice_due_soon triggers */
  @Prop({ type: Types.ObjectId })
  invoiceId?: Types.ObjectId;

  /** Optional — populated for service_maintenance triggers */
  @Prop({ type: Types.ObjectId })
  machineId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  ruleId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['in_app', 'email', 'sms', 'push', 'whatsapp'],
    required: true,
  })
  channel: string;

  /** YYYY-MM-DD — used as part of idempotency key */
  @Prop({ type: String, required: true })
  triggerDate: string;

  @Prop({
    type: String,
    enum: [
      'sent',
      'failed',
      'skipped',
      'skipped_cooldown',
      'skipped_optout',
      'skipped_no_contact',
      'skipped_channel_locked',
      // Wave 8.1 — MSG91 wallet empty; customer credit NOT debited; ops paged.
      'skipped_provider_empty',
    ],
    required: true,
  })
  status: string;

  @Prop({ type: String })
  errorMessage?: string;

  /** MASKED — e.g. '+91*****2345' or 'j***@gmail.com' */
  @Prop({ type: String })
  recipient?: string;

  @Prop({ type: Number })
  escalationLevel?: number;

  /** Provider message ID for delivery receipt correlation */
  @Prop({ type: String })
  messageId?: string;
}

export const ReminderLogSchema = SchemaFactory.createForClass(ReminderLog);

/**
 * CRITICAL: UNIQUE compound index — primary idempotency guard against double-send.
 * MongoDB returns E11000 on second insert attempt; dispatcher catches and skips.
 *
 * invoiceId and machineId are included so that a party with multiple overdue invoices
 * receives one reminder per (invoice, rule, date, channel) tuple — not one per party.
 *
 * sparse: true is required because invoiceId and machineId are optional fields;
 * without sparse, a single null invoiceId would conflict with itself.
 *
 * MIGRATION NOTE: If upgrading from the previous index (without invoiceId/machineId),
 * the old index must be dropped from MongoDB before deploying this change:
 *   db.reminder_logs.dropIndex("workspaceId_1_firmId_1_partyId_1_ruleId_1_triggerDate_1_channel_1")
 * In development: drop the reminder_logs collection and restart.
 */
ReminderLogSchema.index(
  { workspaceId: 1, firmId: 1, partyId: 1, ruleId: 1, invoiceId: 1, machineId: 1, triggerDate: 1, channel: 1 },
  { unique: true, sparse: true },
);
