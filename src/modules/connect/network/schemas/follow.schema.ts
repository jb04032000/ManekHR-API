import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect — `Follow` collection (Phase 2 — Network).
 *
 * An **asymmetric** follow edge — no approval, no reciprocal row (unlike a
 * `Connection`, which is symmetric and consented). A person follows another
 * person, or (from Phase 6) a `CompanyPage`.
 *
 * `followeeType` reserves the `'companyPage'` value now so Phase 6 needs no
 * migration; **Phase 2 only ever creates `'user'` follows** — Company Pages do
 * not exist yet (`docs/connect/phases/phase-2-network.md`).
 */

/** What a `Follow` can point at. Phase 2 creates only `'user'`. */
export const FOLLOW_FOLLOWEE_TYPES = ['user', 'companyPage'] as const;
export type FollowFolloweeType = (typeof FOLLOW_FOLLOWEE_TYPES)[number];

@Schema({ timestamps: true, collection: 'connectfollows' })
export class Follow extends Document {
  /** The `User` doing the following. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  followerId: User | Types.ObjectId;

  /** Whether the followee is a `User` or (Phase 6) a `CompanyPage`. */
  @Prop({ type: String, enum: FOLLOW_FOLLOWEE_TYPES, required: true })
  followeeType: FollowFolloweeType;

  /** The followed entity's id — a `User._id` (Phase 2) or `CompanyPage._id`. */
  @Prop({ type: Types.ObjectId, required: true })
  followeeId: Types.ObjectId;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// One follow edge per (follower, followee) — enforces idempotency + serves the
// unfollow lookup.
FollowSchema.index({ followerId: 1, followeeType: 1, followeeId: 1 }, { unique: true });
// Follower-count + "who follows X" reverse lookup.
FollowSchema.index({ followeeType: 1, followeeId: 1 });
