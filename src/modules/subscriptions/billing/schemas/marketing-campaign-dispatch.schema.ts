import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * D4 — append-only dispatch ledger that idempotently dedups marketing
 * campaign emails. One row per (userId, campaign, anchorKey).
 *
 * `anchorKey` design:
 *   - Trial reminder       → `trial:<subscriptionId>:d<thresholdDay>` (one per
 *                            nudge threshold, e.g. 5/2/1 days out — a small
 *                            cadence, NOT a daily email; legacy callers without
 *                            a threshold still use `trial:<subscriptionId>`)
 *   - Trial ended          → `trial-ended:<subscriptionId>` (one post-expiry
 *                            "you're now on Free" notice per subscription)
 *   - Renewal notice       → `renewal:<subscriptionId>:<periodEndStamp>`
 *   - Win-back             → `winback:<subscriptionId>:<cancelledAtStamp>`
 *   - Abandoned checkout   → `abandoned:<subscriptionPaymentId>`
 *
 * Unique compound index `(userId, campaign, anchorKey)` ensures the
 * cron worker never sends the same email twice even if the cron
 * accidentally fires twice in the same day or after a node restart.
 *
 * Cleanup: rows are append-only. Caller can periodically purge rows
 * older than 1y if collection size becomes a concern. For most
 * deployments the count is bounded by N customers × 4 campaigns ×
 * cycle frequency.
 */
@Schema({
  timestamps: { createdAt: 'sentAt', updatedAt: false },
  collection: 'marketingcampaigndispatches',
})
export class MarketingCampaignDispatch extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['trial_reminder', 'trial_ended', 'renewal_notice', 'win_back', 'abandoned_checkout'],
    required: true,
    index: true,
  })
  campaign: string;

  /**
   * Idempotency key — what window of time / entity this dispatch
   * represents. Convention documented in the class doc above.
   */
  @Prop({ type: String, required: true })
  anchorKey: string;

  /** Subscription this dispatch is bound to (when relevant). */
  @Prop({ type: Types.ObjectId, ref: 'Subscription', sparse: true })
  subscriptionId?: Types.ObjectId;

  /** Payment row this dispatch is bound to (abandoned-checkout). */
  @Prop({ type: Types.ObjectId, ref: 'SubscriptionPayment', sparse: true })
  paymentId?: Types.ObjectId;

  @Prop({ type: String })
  recipientEmail?: string;

  /** Free-form metadata — daysRemaining, periodEnd, etc. */
  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  /** Whether the SMTP send actually succeeded. */
  @Prop({ type: Boolean, default: true })
  delivered: boolean;
}

export const MarketingCampaignDispatchSchema =
  SchemaFactory.createForClass(MarketingCampaignDispatch);

// Idempotency: at most one dispatch per (user, campaign, anchorKey).
MarketingCampaignDispatchSchema.index({ userId: 1, campaign: 1, anchorKey: 1 }, { unique: true });
// Hot path: per-user campaign history.
MarketingCampaignDispatchSchema.index({ userId: 1, sentAt: -1 });
// Hot path: per-campaign reporting.
MarketingCampaignDispatchSchema.index({ campaign: 1, sentAt: -1 });
