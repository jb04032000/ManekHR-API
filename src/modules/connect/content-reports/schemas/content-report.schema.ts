import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  CONTENT_REPORT_REASONS,
  CONTENT_REPORT_STATUSES,
  CONTENT_REPORT_TARGET_TYPES,
  type ContentReportReason,
  type ContentReportStatus,
  type ContentReportTargetType,
} from '../content-reports.constants';

/**
 * ManekHR Connect -- an abuse report against PUBLIC user content (post, comment,
 * profile, listing). Feeds the admin moderation queue (the UGC moderation
 * capability Google AdSense requires before serving ads on a content platform).
 *
 * A `snapshot` of the reported content is captured at report time so the
 * evidence survives a later delete. `targetOwnerUserId` lets the moderator
 * jump straight to suspend the offending account.
 *
 * Cross-module links: content-reports.service (CRUD + takedown emit),
 * content-reports.controller (member report), content-reports.admin.controller
 * (queue). Separate from inbox `connect_message_reports` (private DMs).
 */
@Schema({ timestamps: true, collection: 'connect_content_reports' })
export class ContentReport extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  reporterUserId: Types.ObjectId;

  @Prop({ type: String, enum: CONTENT_REPORT_TARGET_TYPES, required: true })
  targetType: ContentReportTargetType;

  /** Id of the reported entity (post/comment/listing id, or profile user id). */
  @Prop({ type: String, required: true })
  targetId: string;

  /** Owner of the reported content -- the moderator's "suspend this user" link. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  targetOwnerUserId: Types.ObjectId | null;

  @Prop({ type: String, enum: CONTENT_REPORT_REASONS, required: true })
  reason: ContentReportReason;

  @Prop({ type: String, trim: true, maxlength: 1000, default: '' })
  detail: string;

  /** Content text snapshot at report time -- survives a later delete (evidence). */
  @Prop({ type: String, default: '' })
  snapshot: string;

  /** Deep-link path to the live content, for one-click review in the queue. */
  @Prop({ type: String, default: '' })
  targetUrl: string;

  @Prop({ type: String, enum: CONTENT_REPORT_STATUSES, default: 'open', index: true })
  status: ContentReportStatus;

  /** Admin who resolved (actioned/dismissed) the report. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  /** Optional moderator note recorded at resolution. */
  @Prop({ type: String, trim: true, maxlength: 1000, default: '' })
  resolution: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ContentReportDocument = ContentReport & Document;
export const ContentReportSchema = SchemaFactory.createForClass(ContentReport);

// Admin queue: open reports newest-first.
ContentReportSchema.index({ status: 1, createdAt: -1 });
// All reports against one target (cluster repeat reports in the queue).
ContentReportSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
// Dedup guard: one OPEN report per reporter per target.
ContentReportSchema.index({ reporterUserId: 1, targetType: 1, targetId: 1, status: 1 });
