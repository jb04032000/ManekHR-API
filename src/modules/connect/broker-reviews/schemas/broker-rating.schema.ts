import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect — denormalized per-broker rating aggregate (Broker Reviews
 * slice). One row per rated `brokerUserId`, recomputed on every review
 * write/withdraw, so a broker's public profile reads ONE doc instead of
 * aggregating reviews per render. Mirrors `SellerRating`
 * (`reviews/schemas/seller-rating.schema.ts`) — rating stats ONLY (the
 * introductions-confirmed / distinct-people proof counts are computed live from
 * the `Introduction` collection, not stored here).
 *
 * `ratingAvg` is what is DISPLAYED; `wilsonScore` (Wilson lower bound over
 * `rating >= 4` positives) is the quality sort key that resists small-sample
 * inflation.
 */
@Schema({ timestamps: true, collection: 'connect_broker_ratings' })
export class BrokerRating extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  brokerUserId: User | Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  ratingCount: number;

  /** Mean rating, 1 decimal — the displayed value. */
  @Prop({ type: Number, default: 0 })
  ratingAvg: number;

  /** Count of `rating >= 4` (the Wilson "positive"s). */
  @Prop({ type: Number, default: 0 })
  positiveCount: number;

  /** Wilson lower bound (z=1.96) — the quality sort key. */
  @Prop({ type: Number, default: 0 })
  wilsonScore: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export type BrokerRatingDocument = BrokerRating & Document;
export const BrokerRatingSchema = SchemaFactory.createForClass(BrokerRating);

// "Top rated broker" ordering.
BrokerRatingSchema.index({ wilsonScore: -1 });
