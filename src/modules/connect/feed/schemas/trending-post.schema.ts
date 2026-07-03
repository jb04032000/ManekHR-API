import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';

/**
 * ManekHR Connect — materialized trending set (feed hardening B2).
 *
 * A small, periodically-recomputed table of the top trending public posts +
 * their decayed score. A recurring job (`TrendingRefreshService`) replaces this
 * set every few minutes; the feed's `TrendingSource` + the right-rail read it
 * (sorted by `score` desc) instead of scanning the post corpus on every
 * request. This both removes the per-request scan AND lets a genuinely viral
 * post that is older than the "newest N" window still surface (the per-request
 * scan only saw the newest slice). The denormalized `authorId` lets a reader
 * filter blocked / own authors without a `Post` join.
 */
@Schema({ timestamps: true, collection: 'connect_trending' })
export class TrendingPost extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true, unique: true })
  postId: Post | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: User | Types.ObjectId;

  /** Decayed popularity score (Hacker-News-style gravity); higher = hotter. */
  @Prop({ type: Number, required: true })
  score: number;

  /** When this row was written by the refresh job (staleness guard). */
  @Prop({ type: Date, required: true })
  computedAt: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type TrendingPostDocument = TrendingPost & Document;
export const TrendingPostSchema = SchemaFactory.createForClass(TrendingPost);

// Read path: top trending first.
TrendingPostSchema.index({ score: -1 });
