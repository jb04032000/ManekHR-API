import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';
import { Post } from './post.schema';
import { Mention, MentionSchema } from './mention.subschema';

/**
 * ManekHR Connect — `Comment` collection (Phase 3 — Feed).
 *
 * A comment on a post. Threading is **one level deep**: a top-level comment has
 * `parentId = null`; a reply sets `parentId` to a top-level comment, and the
 * service refuses a reply-to-a-reply (`phase-3-feed.md` scope). Soft-deleted
 * (`deletedAt`) so a removed comment leaves its replies' thread intact and the
 * post's `commentCount` stays auditable.
 *
 * Every `@Prop` carries an explicit `{ type }` — see `post.schema.ts`.
 */

@Schema({ timestamps: true, collection: 'connectcomments' })
export class Comment extends Document {
  /** The commented-on `Post`. */
  @Prop({ type: Types.ObjectId, ref: 'Post', required: true })
  postId: Post | Types.ObjectId;

  /** The `User` who wrote the comment. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: User | Types.ObjectId;

  /** The comment text. */
  @Prop({ type: String, required: true, trim: true, maxlength: 1000 })
  body: string;

  /** @mentions (tags) in this comment body - same shape as Post.mentions. */
  @Prop({ type: [MentionSchema], default: [] })
  mentions: Mention[];

  /**
   * Parent comment for a one-level reply; `null` → a top-level comment. A
   * string `ref` (not `Comment.name`) avoids a class self-reference TDZ error
   * at decoration time.
   */
  @Prop({ type: Types.ObjectId, ref: 'Comment', default: null })
  parentId?: Comment | Types.ObjectId | null;

  /** Soft-delete marker. `null` → live; set → hidden, replies kept. */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const CommentSchema = SchemaFactory.createForClass(Comment);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// A post's comment thread, oldest-first.
CommentSchema.index({ postId: 1, createdAt: 1 });
// A top-level comment's replies.
CommentSchema.index({ parentId: 1, createdAt: 1 });
// Keyset pagination of a post's TOP-LEVEL comments, newest-first with an _id
// tiebreak (see CommentService.listComments + common/keyset-cursor).
CommentSchema.index({ postId: 1, parentId: 1, createdAt: -1, _id: -1 });
// Per-(author,post) anti-spam window queries — the rate-limit counts + the
// duplicate-body lookback in CommentService.addComment scan this exact prefix
// (authorId + postId + a createdAt range). Newest-first so the bounded
// duplicate window reads the most recent rows first.
CommentSchema.index({ authorId: 1, postId: 1, createdAt: -1 });
