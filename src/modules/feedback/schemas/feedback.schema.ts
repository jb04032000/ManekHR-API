import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';

export const FEEDBACK_CATEGORIES = ['feature_request', 'bug_report', 'general'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

// Whether the feedback is about the current page or the product overall. Drives
// the admin scope filter. The page is recorded in `context` either way.
export const FEEDBACK_SCOPES = ['page', 'general'] as const;
export type FeedbackScope = (typeof FEEDBACK_SCOPES)[number];

export const FEEDBACK_STATUSES = [
  'new',
  'reviewed',
  'in_progress',
  'resolved',
  'wont_fix',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

// Auto-captured diagnostics attached to each feedback (no extra PII; userId +
// workspaceId already live on the parent doc). Embedded, _id-less subdoc.
// Populated client-side by the feedback panel; read by the admin console.
// Every @Prop carries an explicit { type } (Mongoose 8.23 autocast guard).
@Schema({ _id: false })
export class FeedbackContext {
  @Prop({ type: String, default: null }) path: string | null; // route, no query
  @Prop({ type: String, default: null }) locale: string | null;
  @Prop({ type: String, default: null }) userAgent: string | null;
  @Prop({ type: String, default: null }) viewport: string | null; // "1440x900"
  @Prop({ type: String, default: null }) appVersion: string | null;
}
export const FeedbackContextSchema = SchemaFactory.createForClass(FeedbackContext);

@Schema({ timestamps: true })
export class Feedback extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: User | Types.ObjectId;

  @Prop({ type: String, required: true, maxlength: 60 })
  module: string;

  // Optional now: general feedback / pure bug reports need no satisfaction
  // score. Existing rows already carry a value; new rows may store null.
  @Prop({ type: Number, required: false, default: null, min: 1, max: 5 })
  rating: number | null;

  @Prop({ type: String, required: true, maxlength: 2000 })
  message: string;

  @Prop({
    type: String,
    enum: FEEDBACK_CATEGORIES,
    default: 'general',
  })
  category: FeedbackCategory;

  // 'page' (about the current screen) vs 'general' (whole product). Admin filter.
  @Prop({ type: String, enum: FEEDBACK_SCOPES, default: 'page' })
  scope: FeedbackScope;

  // Canonical `r2-private://erp-feedback-media/...` refs (never public URLs).
  // 3-cap enforced by CreateFeedbackDto (ArrayMaxSize), not the schema.
  @Prop({ type: [String], default: [] })
  attachments: string[];

  // Auto-captured page/device diagnostics (see FeedbackContext).
  @Prop({ type: FeedbackContextSchema, default: null })
  context: FeedbackContext | null;

  @Prop({
    type: String,
    enum: FEEDBACK_STATUSES,
    default: 'new',
  })
  status: FeedbackStatus;

  @Prop({ type: String, default: null })
  adminNotes: string | null;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export const FeedbackSchema = SchemaFactory.createForClass(Feedback);
FeedbackSchema.index({ workspaceId: 1, createdAt: -1 });
FeedbackSchema.index({ status: 1, createdAt: -1 });
FeedbackSchema.index({ module: 1, createdAt: -1 });
