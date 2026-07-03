import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect — denormalized per-seller rating aggregate (marketplace Phase
 * C). One row per rated `subjectUserId`, recomputed on every review write/delete,
 * so a profile / company / marketplace card reads ONE doc instead of aggregating
 * reviews per render. `ratingAvg` is what is DISPLAYED; `wilsonScore` (the Wilson
 * lower bound over `rating >= 4` positives) is the "top rated" sort key, which
 * resists small-sample inflation (one 5-star does not outrank a 4.6 over 50).
 */
@Schema({ timestamps: true, collection: 'connect_seller_ratings' })
export class SellerRating extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  subjectUserId: User | Types.ObjectId;

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

export type SellerRatingDocument = SellerRating & Document;
export const SellerRatingSchema = SchemaFactory.createForClass(SellerRating);

// "Top rated" ordering.
SellerRatingSchema.index({ wilsonScore: -1 });
