import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  INBOX_REPORT_REASONS,
  INBOX_REPORT_STATUSES,
  type InboxReportReason,
  type InboxReportStatus,
} from '../inbox.constants';

/**
 * ManekHR Connect -- a message / thread abuse report (Phase 7 -- Inbox).
 *
 * Feeds the admin moderation queue (wave I5). Captures a `messageSnapshot` of
 * the reported body at report time so deleting the message later does not
 * destroy the evidence. Person-centric: reporter + reported are `User` ids.
 */
@Schema({ timestamps: true, collection: 'connect_message_reports' })
export class InboxReport extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reporterUserId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reportedUserId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Thread', required: true })
  threadId: Types.ObjectId;

  /** The specific reported message, when the report targets one. */
  @Prop({ type: Types.ObjectId, ref: 'Message', default: null })
  messageId: Types.ObjectId | null;

  /** Body snapshot at report time -- survives a later message delete. */
  @Prop({ type: String, default: '' })
  messageSnapshot: string;

  @Prop({ type: String, enum: INBOX_REPORT_REASONS, required: true })
  reason: InboxReportReason;

  @Prop({ type: String, trim: true, maxlength: 1000, default: '' })
  detail: string;

  @Prop({ type: String, enum: INBOX_REPORT_STATUSES, default: 'open' })
  status: InboxReportStatus;

  createdAt?: Date;
  updatedAt?: Date;
}

export type InboxReportDocument = InboxReport & Document;
export const InboxReportSchema = SchemaFactory.createForClass(InboxReport);

// Admin queue: open reports newest-first.
InboxReportSchema.index({ status: 1, createdAt: -1 });
// A reporter's reports against a target (dedup / rate-limit signal in I5).
InboxReportSchema.index({ reporterUserId: 1, reportedUserId: 1, createdAt: -1 });
