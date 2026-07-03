import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

export type ReviewStatus = 'active' | 'hidden';
export const REVIEW_STATUSES: readonly ReviewStatus[] = ['active', 'hidden'] as const;

/**
 * ManekHR Connect — a seller/person review (marketplace Phase C).
 *
 * One review per (reviewer, subject) — editable (an upsert). The subject is the
 * person being rated (a seller / karigar / workshop owner), keyed on their
 * `User` id (person-centric, never a workspace). Open to any signed-in member in
 * v1 (no proven-transaction gate); `verifiedPurchase` is reserved (false now) so
 * a later trust gate / weighting drops in without a migration.
 */
@Schema({ timestamps: true, collection: 'connect_reviews' })
export class Review extends Document {
  /** Who wrote the review. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reviewerUserId: User | Types.ObjectId;

  /** The person being rated. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  subjectUserId: User | Types.ObjectId;

  /** 1-5 stars. */
  @Prop({ type: Number, required: true, min: 1, max: 5 })
  rating: number;

  /** Optional free-text review body. */
  @Prop({ type: String, default: '', trim: true, maxlength: 1000 })
  text: string;

  /**
   * RESERVED — set false now; a future transaction signal flips it so reviews
   * tied to a real deal can be weighted / labelled.
   * TODO(review-trust): gate / weight by a real inquiry or transaction signal.
   */
  @Prop({ type: Boolean, default: false })
  verifiedPurchase: boolean;

  /** Moderation state — a reported + actioned review is hidden from reads. */
  @Prop({ type: String, enum: REVIEW_STATUSES, default: 'active' })
  status: ReviewStatus;

  /** Abuse-report tally (a moderation hook can auto-hide past a threshold). */
  @Prop({ type: Number, default: 0 })
  reportCount: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ReviewDocument = Review & Document;
export const ReviewSchema = SchemaFactory.createForClass(Review);

// One review per (reviewer, subject) — the editable-upsert + dedup backstop.
ReviewSchema.index({ reviewerUserId: 1, subjectUserId: 1 }, { unique: true });
// A subject's active reviews, newest first — the public list read.
ReviewSchema.index({ subjectUserId: 1, status: 1, createdAt: -1 });
