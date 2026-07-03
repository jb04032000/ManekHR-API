import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/** Moderation state — a review is `active` (shown) or `hidden`. The broker can
 *  NEVER set this; only an admin/moderation hook could. Mirrors `ReviewStatus`. */
export type BrokerReviewStatus = 'active' | 'hidden';
export const BROKER_REVIEW_STATUSES: readonly BrokerReviewStatus[] = ['active', 'hidden'] as const;

/** Reviewer's display preference: anonymous (default) hides the name; named opts
 *  in to show it on the public card. */
export type BrokerReviewVisibility = 'anonymous' | 'named';
export const BROKER_REVIEW_VISIBILITIES: readonly BrokerReviewVisibility[] = [
  'anonymous',
  'named',
] as const;

/** The role the reviewer held in the anchoring introduction (buyer/seller). */
export type BrokerReviewerRole = 'buyer' | 'seller';
export const BROKER_REVIEWER_ROLES: readonly BrokerReviewerRole[] = ['buyer', 'seller'] as const;

/**
 * Sub-document: the broker's single reply to a review. The broker may post this
 * ONCE and may never change it (the service guards the write). Mirrors the
 * `ConnectPortfolioItem`-style sub-schema pattern — explicit `{ type }` on every
 * prop, `_id: false` so it is an embedded value not its own collection row.
 */
@Schema({ _id: false })
export class BrokerReply {
  @Prop({ type: String, required: true, trim: true, maxlength: 1000 })
  text: string;

  @Prop({ type: Date, required: true })
  repliedAt: Date;
}
export const BrokerReplySchema = SchemaFactory.createForClass(BrokerReply);

/**
 * ManekHR Connect — a verified-but-anonymous review of a BROKER, anchored to a
 * CONFIRMED introduction (Broker Reviews slice). Mirrors `Review`
 * (`reviews/schemas/review.schema.ts`): one review per (reviewer, anchor),
 * 1-5 stars, trimmed text, `status` moderation, denormalized aggregate.
 *
 * Differences from `Review`, all enforced in the service:
 *   - the anchor is an `introductionId` (a CONFIRMED introduction the reviewer is
 *     a party of), not a free choice of subject — `brokerUserId` is DERIVED from
 *     that introduction, never trusted from the request body;
 *   - reviews are anonymous by default (`visibility`), named is opt-in;
 *   - the broker (subject) can NEVER edit/delete/hide a review — only post ONE
 *     `brokerReply`; deletion is the reviewer's via a soft-delete `deletedAt`.
 */
@Schema({ timestamps: true, collection: 'connect_broker_reviews' })
export class BrokerReview extends Document {
  /** The broker being reviewed. DERIVED from the anchoring introduction. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  brokerUserId: User | Types.ObjectId;

  /** Who wrote the review (a party of the confirmed introduction). Never leaked
   *  in any public payload. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reviewerUserId: User | Types.ObjectId;

  /** The CONFIRMED introduction this review is anchored to (the proof). */
  @Prop({ type: Types.ObjectId, ref: 'Introduction', required: true })
  introductionId: Types.ObjectId;

  /** 1-5 stars. */
  @Prop({ type: Number, required: true, min: 1, max: 5 })
  rating: number;

  /** Optional free-text review body. */
  @Prop({ type: String, required: false, trim: true, maxlength: 1000 })
  text?: string;

  /** Anonymous (default) hides the reviewer's name on the public card; named
   *  opts in to show it. */
  @Prop({ type: String, enum: BROKER_REVIEW_VISIBILITIES, default: 'anonymous' })
  visibility: BrokerReviewVisibility;

  /** The reviewer's role in the anchoring introduction (buyer/seller). DERIVED
   *  from the introduction — shown on the anonymized card ("Verified buyer"). */
  @Prop({ type: String, enum: BROKER_REVIEWER_ROLES, required: true })
  reviewerRoleAtIntro: BrokerReviewerRole;

  /** The reviewer's city at review time, snapshotted from their ConnectProfile
   *  so a later profile edit cannot retroactively re-identify a thin-market card. */
  @Prop({ type: String, required: false, trim: true, maxlength: 80 })
  reviewerCitySnapshot?: string;

  /** Moderation state. The broker can NEVER set this. */
  @Prop({ type: String, enum: BROKER_REVIEW_STATUSES, default: 'active' })
  status: BrokerReviewStatus;

  /** The broker's single reply (set once via `replyToReview`; immutable after). */
  @Prop({ type: BrokerReplySchema, required: false, default: null })
  brokerReply?: BrokerReply | null;

  /** Soft-delete tombstone — set on the reviewer's withdraw (never hard-delete,
   *  mirrors the retained-record discipline). */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type BrokerReviewDocument = BrokerReview & Document;
export const BrokerReviewSchema = SchemaFactory.createForClass(BrokerReview);

// One review per (reviewer, anchoring introduction) — the upsert + dedup backstop.
BrokerReviewSchema.index({ reviewerUserId: 1, introductionId: 1 }, { unique: true });
// A broker's active, non-deleted reviews — the public card read + aggregate.
BrokerReviewSchema.index({ brokerUserId: 1, status: 1, deletedAt: 1 });
