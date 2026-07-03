import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';
import { SEEN_RETENTION_SECONDS } from '../feed.constants';

/**
 * ManekHR Connect — `SeenPost` (Phase 7c — seen-suppression).
 *
 * ONE row per (viewer, post): the viewer has already had this post in their
 * viewport. Used only to suppress a post from the viewer's For-You DISCOVERY
 * candidates so the same trending / topic post does not reappear on every
 * refresh — it is NOT a read receipt and the Following tab is never filtered
 * by it. Written from the same viewport-impression signal that bumps
 * `Post.viewCount`, so a single client observer feeds both.
 *
 * A TTL index expires rows after `SEEN_RETENTION_SECONDS`, which (a) keeps the
 * collection bounded without a cron and (b) lets a post resurface in discovery
 * once it has been out of the viewer's feed for long enough.
 *
 * Every `@Prop` carries an explicit `{ type }` — required by `@nestjs/mongoose`
 * and the repo's Vitest SWC transform so `SchemaFactory.createForClass`
 * resolves without `emitDecoratorMetadata`.
 */
@Schema({ timestamps: false, collection: 'connectseenposts' })
export class SeenPost extends Document {
  /** The viewer who saw the post. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewerId: User | Types.ObjectId;

  /** The post that was seen. */
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true })
  postId: Post | Types.ObjectId;

  /** First-seen timestamp — drives the TTL expiry. */
  @Prop({ type: Date, default: Date.now })
  seenAt: Date;
}

export const SeenPostSchema = SchemaFactory.createForClass(SeenPost);

// One row per (viewer, post) — idempotent impression upsert + dedup backstop.
SeenPostSchema.index({ viewerId: 1, postId: 1 }, { unique: true });
// The per-read seen-set load (`FeedService.getSeenPostIds`) filters by viewer and
// sorts by `seenAt` desc to take the most-recent `SEEN_LOAD_LIMIT`. The unique
// index above covers the viewer filter but NOT the sort, forcing an in-memory
// sort of a viewer's whole seen-set; this compound index makes the load fully
// index-backed (examined ≈ returned) and bounds it as the set grows.
SeenPostSchema.index({ viewerId: 1, seenAt: -1 });
// TTL — expire rows so the seen-set stays bounded and posts can resurface.
SeenPostSchema.index({ seenAt: 1 }, { expireAfterSeconds: SEEN_RETENTION_SECONDS });
