import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';

/**
 * ManekHR Connect — `Reaction` collection (Phase 3 — Feed).
 *
 * One row per (post, user) — a member's reaction to a post. Phase 3 ships a
 * single reaction `type` (`like`); the enum reserves room for an
 * industry-specific sticker set deferred to Phase 4 (design-decisions doc §17).
 * The unique `{ postId, userId }` index makes reacting idempotent and lets the
 * `react` / `unreact` toggle probe a single row.
 *
 * Every `@Prop` carries an explicit `{ type }` — see `post.schema.ts`.
 */

/** `Reaction.type` — Phase 3 ships only `like`; the enum is forward-room. */
export const REACTION_TYPES = ['like'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

@Schema({ timestamps: true, collection: 'connectreactions' })
export class Reaction extends Document {
  /** The reacted-to `Post`. */
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true })
  postId: Post | Types.ObjectId;

  /** The `User` who reacted. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: User | Types.ObjectId;

  /** Reaction kind — `like` only in Phase 3. */
  @Prop({ type: String, enum: REACTION_TYPES, default: 'like' })
  type: ReactionType;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ReactionSchema = SchemaFactory.createForClass(Reaction);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// One reaction per user per post — idempotency + the toggle lookup.
ReactionSchema.index({ postId: 1, userId: 1 }, { unique: true });
