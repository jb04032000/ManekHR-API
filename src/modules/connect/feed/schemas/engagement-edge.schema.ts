import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';

/** The kinds of engagement an actor can have with a post. */
export type EngagementType = 'react' | 'comment' | 'repost' | 'share' | 'view';

/** Closed list of engagement types — single source for the schema enum + guards. */
export const ENGAGEMENT_TYPES: readonly EngagementType[] = [
  'react',
  'comment',
  'repost',
  'share',
  'view',
] as const;

/**
 * ManekHR Connect — `EngagementEdge` (Phase 7c — feed discovery + analytics).
 *
 * A unified, denormalized log of "actor engaged with post" — ONE row per
 * (actor, post, type). It is NOT the source of truth for reactions / comments
 * (those keep their own collections); it is the cross-cutting signal layer that
 * powers:
 *   (a) **network-out discovery** — "posts the people you follow engaged with"
 *       (traverse by a set of `actorId`s, newest first);
 *   (b) **per-post analytics** incl. unique viewers (`view` edges) — "how many
 *       people watched this post / boosted post";
 *   (c) later **repost / share** fan-in.
 *
 * Upserted on engage, removed on dis-engage (react ↔ unreact). The
 * `{ actorId, postId, type }` unique index makes the write idempotent and is
 * the dedup backstop.
 */
@Schema({ timestamps: true, collection: 'connectengagementedges' })
export class EngagementEdge extends Document {
  /** Who engaged. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: User | Types.ObjectId;

  /** The post engaged with. */
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true })
  postId: Post | Types.ObjectId;

  /**
   * Denormalized post author — lets network-out discovery rank by author
   * affinity without a `Post` join on a hot traversal.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: User | Types.ObjectId;

  @Prop({ type: String, enum: ENGAGEMENT_TYPES, required: true })
  type: EngagementType;

  createdAt?: Date;
  updatedAt?: Date;
}

export const EngagementEdgeSchema = SchemaFactory.createForClass(EngagementEdge);

// One edge per (actor, post, type) — idempotent upsert + dedup backstop.
EngagementEdgeSchema.index({ actorId: 1, postId: 1, type: 1 }, { unique: true });
// Network-out discovery: "what the people I follow recently engaged with",
// newest first — traversed by a set of actorIds.
EngagementEdgeSchema.index({ actorId: 1, createdAt: -1 });
// Per-post engagement lookups — unique-viewer / engager counts by type.
EngagementEdgeSchema.index({ postId: 1, type: 1 });

/**
 * No TTL on `view` edges (ADR-0002). A `view` edge is the PERMANENT dedup marker
 * behind `Post.viewCount` = lifetime unique viewers: each (viewer, post) counts
 * exactly once, forever, never re-counted. A TTL here would expire the marker and
 * let the same viewer re-increment the count later (upward drift), so it was
 * removed. Storage is instead bounded by content lifecycle — `FeedService.deletePost`
 * cascades a deleted post's view edges (+ seen rows). The only reader of view
 * edges, `FeedService.getAffinityMap`, already filters `createdAt >= now − 60d`,
 * so removing the TTL does not widen any read. A one-shot migration drops the old
 * `engagement_view_ttl` index from existing DBs (migrations/drop-engagement-view-ttl-index).
 * Scale path when this collection grows large: probabilistic unique counts (HLL).
 */
