import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';

/**
 * ManekHR Connect - `SavedPost` collection (Phase 7c / Wave 6 - Saved posts).
 *
 * A private bookmark: one row per (user, post). It is NOT fanned out and carries
 * NO ranking score - the Saved tab is a plain reverse-chronological list of the
 * rows a member created, keyed by save time. The `{ userId, postId }` unique
 * index makes a save idempotent (a double-tap never double-saves) and is the
 * dedup backstop; `{ userId, createdAt }` powers the windowed Saved read.
 *
 * Every `@Prop` carries an explicit `{ type }` - see `post.schema.ts` for why.
 */
@Schema({ timestamps: true, collection: 'connectsavedposts' })
export class SavedPost extends Document {
  /** The member who saved the post. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: User | Types.ObjectId;

  /** The saved post. */
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true })
  postId: Post | Types.ObjectId;

  // `createdAt` (the save time, the Saved-list sort key) / `updatedAt` are added
  // by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const SavedPostSchema = SchemaFactory.createForClass(SavedPost);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// One row per (user, post) - makes a save idempotent + the un-save lookup exact.
SavedPostSchema.index({ userId: 1, postId: 1 }, { unique: true });
// The windowed Saved read - a member's saved posts, newest-saved first.
SavedPostSchema.index({ userId: 1, createdAt: -1 });
