import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * A "show me less" action the CLIENT can send (Phase 7c). The DTO guard accepts
 * ONLY these — `not_interested_author` below is server-derived, never client-set.
 */
export type ClientNegativeSignalKind = 'hide_post' | 'not_interested' | 'mute_author';

/**
 * Every stored kind = the client kinds PLUS the server-DERIVED author dampen
 * (`not_interested_author`, raised when a viewer marks >= 3 of one author's
 * posts not-interested within 90d — Phase 7d, spec A3).
 */
export type NegativeSignalKind = ClientNegativeSignalKind | 'not_interested_author';

/** Client-settable kinds — single source for the `NegativeSignalDto` guard. */
export const CLIENT_NEGATIVE_SIGNAL_KINDS: readonly ClientNegativeSignalKind[] = [
  'hide_post',
  'not_interested',
  'mute_author',
] as const;

/** All stored kinds — the schema enum (client kinds + the derived author kind). */
export const NEGATIVE_SIGNAL_KINDS: readonly NegativeSignalKind[] = [
  ...CLIENT_NEGATIVE_SIGNAL_KINDS,
  'not_interested_author',
] as const;

/**
 * `FeedNegativeSignal` (Phase 7c, reshaped Phase 7d) — a viewer's "show me less"
 * actions. One row per (viewer, kind, target), idempotent upsert. The feed read
 * loads a viewer's rows once per build and splits them two ways:
 *
 *   HARD EXCLUSION (never returned in EITHER tab):
 *     - `hide_post`       → `targetId` is a post id   → drop that post;
 *     - `not_interested`  → `targetId` is a post id   → drop that post too (it
 *                           ALSO dampens For-You scoring, see below);
 *     - `mute_author`     → `targetId` is an author id → drop ALL their posts,
 *                           until the mute `expiresAt` (default +30d) passes.
 *
 *   DAMPEN (For-You scoring; layered on top of the not-interested exclusion so the
 *   author-derivation signal still feeds the ranker):
 *     - `not_interested`        → a single mild post down-rank;
 *     - `not_interested_author` → the DERIVED author down-rank (>= 3 marks/90d).
 *
 * Blocks (`UserBlock`) remain a separate, absolute exclusion.
 */
@Schema({ timestamps: true, collection: 'connectfeednegativesignals' })
export class FeedNegativeSignal extends Document {
  /** Who muted / hid / marked not-interested. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewerId: User | Types.ObjectId;

  @Prop({ type: String, enum: NEGATIVE_SIGNAL_KINDS, required: true })
  kind: NegativeSignalKind;

  /**
   * A post id (`hide_post` / `not_interested`) or an author `User` id
   * (`mute_author` / `not_interested_author`).
   */
  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  /**
   * When this signal stops applying. SET only for `mute_author` (now + 30d) so a
   * mute auto-lifts via the TTL index below. Absent/null on every other kind —
   * Mongo TTL ignores rows whose `expiresAt` is not a Date, so hide /
   * not-interested rows persist (their scoring weight decays in code instead).
   */
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  createdAt?: Date;
}

export const FeedNegativeSignalSchema = SchemaFactory.createForClass(FeedNegativeSignal);

// Idempotent upsert + dedup backstop.
FeedNegativeSignalSchema.index({ viewerId: 1, kind: 1, targetId: 1 }, { unique: true });
// Load every signal for a viewer once per feed build.
FeedNegativeSignalSchema.index({ viewerId: 1 });
// TTL — expire a mute at its `expiresAt` (expireAfterSeconds:0 = "at the stored
// date"). Rows with a null/absent expiresAt (hide / not-interested) are skipped
// by the TTL monitor, so only mutes auto-lift.
FeedNegativeSignalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
