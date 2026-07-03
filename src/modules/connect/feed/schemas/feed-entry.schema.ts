import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';

/**
 * ManekHR Connect — `FeedEntry` collection (Phase 3 — Feed).
 *
 * The fan-out index — one row per (feed owner, post). When a member posts, a
 * BullMQ worker writes a `FeedEntry` for the author and every follower
 * (`phase-3-feed.md` B4); a feed read is then one indexed query over this
 * collection.
 *
 * Deliberately **thin and viewer-agnostic** — it stores NO ranking score.
 * Ranking is a read-time function (`FeedService`, B3): the `For You` tab scores
 * a candidate window with the viewer's live profile in hand, so a feed
 * re-personalises the instant intent changes and a future learned ranker is a
 * swap with no migration.
 *
 * Every `@Prop` carries an explicit `{ type }` — see `post.schema.ts`.
 */

@Schema({ timestamps: true, collection: 'connectfeedentries' })
export class FeedEntry extends Document {
  /** Whose feed this row belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: User | Types.ObjectId;

  /** The post placed in that feed. */
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true })
  postId: Post | Types.ObjectId;

  /** Denormalized post author — saves a `Post` join when filtering a feed. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: User | Types.ObjectId;

  /**
   * Denormalized `Post.companyPageId` — set when the post was published as a
   * company page, so the feed renders the page identity without a `Post` join.
   * `null` for a normal personal post.
   */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', default: null })
  companyPageId?: Types.ObjectId | null;

  /**
   * Denormalized `Post.createdAt` — the chronological-feed sort key. Copied so
   * the `Following` order is the true post time, stable even if the fan-out
   * job runs late (the row's own `createdAt` is the fan-out time).
   */
  @Prop({ type: Date, required: true })
  postedAt: Date;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const FeedEntrySchema = SchemaFactory.createForClass(FeedEntry);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// The windowed feed read — a member's feed, newest post first.
FeedEntrySchema.index({ ownerId: 1, postedAt: -1 });
// One entry per (owner, post) — makes the fan-out worker idempotent.
FeedEntrySchema.index({ ownerId: 1, postId: 1 }, { unique: true });

/**
 * Retention — Mongo auto-removes a materialized feed row this many days after
 * it was WRITTEN, bounding per-user feed growth with zero per-write cost (the
 * memory/resource-management contract). The source `Post` is untouched
 * (Profile Activity reads Posts directly), and the feed is a rolling window, so
 * trimming the materialization is safe. Keyed on the row's own `createdAt`
 * (materialization time, not post time) so a backfilled OLD post still lives
 * its full window rather than expiring immediately.
 */
export const FEED_ENTRY_TTL_DAYS = 180;
FeedEntrySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: FEED_ENTRY_TTL_DAYS * 24 * 60 * 60, name: 'feed_entry_ttl' },
);
