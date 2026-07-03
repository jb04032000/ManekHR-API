import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type { ConnectLimitKind } from '../../monetization/connect-allowance.service';

/**
 * Per-(user, kind) over-limit EPISODE state. This is the ONLY thing persisted by
 * the over-limit feature — the suppressed item set itself is always computed at
 * read time (drift-free) and never stored. See
 * docs/connect/2026-06-12-connect-over-limit-policy.md.
 *
 * `overLimitSince` is the fair-warning clock: set the first time the person goes
 * over the count limit for this kind, cleared the moment they return under it
 * (episode ends). `notifiedAt` guards the once-per-episode entry notification.
 *
 * Maintained idempotently (convergent upsert) by ConnectOverLimitService —
 * lazily on every GET /me/connect/usage read AND nightly by the reconcile cron
 * (so passive users still get the clock + notice on time).
 */
@Schema({ collection: 'connect_over_limit_states', timestamps: true })
export class ConnectOverLimitState extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Which count limit this episode tracks. */
  @Prop({ type: String, enum: ['listing', 'storefront', 'company_page', 'job'], required: true })
  kind: ConnectLimitKind;

  /**
   * Start of the CURRENT over-limit episode (null when the person is under the
   * limit). Suppression under `hide_newest` only begins at
   * `overLimitSince + graceDays`. Resets to null when usage drops to/under limit.
   */
  @Prop({ type: Date, default: null })
  overLimitSince: Date | null;

  /**
   * When the once-per-episode "you are over limit" notification was sent for the
   * current episode. Null while no episode is active (or before the notice
   * fires). Cleared together with `overLimitSince` when the episode ends, so a
   * later episode re-notifies exactly once.
   */
  @Prop({ type: Date, default: null })
  notifiedAt: Date | null;
}

export const ConnectOverLimitStateSchema = SchemaFactory.createForClass(ConnectOverLimitState);

// One episode row per person per kind. Unique so the convergent upsert in
// ConnectOverLimitService can never create duplicates under concurrency
// (web lazy reconcile + worker cron can race).
ConnectOverLimitStateSchema.index({ userId: 1, kind: 1 }, { unique: true });
