import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Single global document holding policy knobs for the billing engine. Edited
 * via the admin panel (D1j). Singleton — there's exactly one row at any time;
 * the service layer reads + caches it. Defaults baked in here so the system
 * still works before any admin has opened the policy editor.
 *
 * Why a doc, not env vars: admin-friendly runtime overrides, audit-logged
 * changes, and ability to scope policy variations later (e.g. per-tier
 * grace days) without touching code.
 */
@Schema({ _id: false })
export class FailedPaymentRetryPolicy {
  /** How many times Razorpay should reattempt a failed renewal charge. */
  @Prop({ default: 3 }) maxAttempts: number;

  /** Days between retry attempts. */
  @Prop({ default: 2 }) retryIntervalDays: number;
}

@Schema({ _id: false })
export class GracePeriodPolicy {
  /** Days after the final failed charge before the plan locks. */
  @Prop({ default: 7 }) durationDays: number;

  /** If true, the workspace is read-only (no writes) during the grace period. */
  @Prop({ default: true }) readOnlyMode: boolean;

  /**
   * Whether to surface a "Contact sales" CTA when the customer's renewal
   * has failed all retries. Useful for high-value enterprise customers
   * where manual intervention is the right path.
   */
  @Prop({ default: true }) showContactSalesCta: boolean;
}

@Schema({ _id: false })
export class TrialPolicy {
  /** Default trial length in days for plans that don't override. */
  @Prop({ default: 14 }) defaultDurationDays: number;

  /**
   * Default for whether the trial requires a card up-front. Per-plan flag
   * `Plan.trialCardRequired` overrides per plan.
   */
  @Prop({ default: false }) defaultCardRequired: boolean;

  /**
   * Window (in days before trial end) within which trial-reminder nudges fire.
   * Default 5 (was 3) — gives room for the multi-nudge cadence derived in
   * `trial-reminder.thresholds.ts` (~3 nudges at 5/2/1 days out, never daily).
   * Admin-editable; the cadence clamps to whatever window is set.
   */
  @Prop({ default: 5 }) reminderEmailDaysBeforeEnd: number;
}

/**
 * D4 — marketing automation toggles. Each campaign can be turned off
 * per-deployment without touching code. Defaults: all on.
 */
@Schema({ _id: false })
export class MarketingPolicy {
  /** Send "trial ends in N days" reminder. Days from `TrialPolicy.reminderEmailDaysBeforeEnd`. */
  @Prop({ default: true }) sendTrialReminder: boolean;

  /** Send "your subscription will renew in N days" pre-renewal notice. */
  @Prop({ default: true }) sendRenewalNotice: boolean;

  /** How many days before currentPeriodEnd to fire the renewal notice. */
  @Prop({ default: 3 }) renewalNoticeDaysBeforeEnd: number;

  /** Send win-back email N days after subscription cancellation/expiry. */
  @Prop({ default: true }) sendWinBack: boolean;

  /** Days after status=cancelled/expired to fire the win-back email. */
  @Prop({ default: 14 }) winBackAfterDays: number;

  /** Send abandoned-checkout follow-up. */
  @Prop({ default: true }) sendAbandonedCheckout: boolean;

  /**
   * Hours after a SubscriptionPayment row was created (status=created and
   * never captured) to fire the abandoned-checkout email.
   */
  @Prop({ default: 24 }) abandonedCheckoutAfterHours: number;
}

/**
 * Admin-configurable proration policy. Controls how plan upgrades and
 * downgrades are priced at runtime. Defaults reflect the owner-approved
 * stance: prorated upgrades (credit unused value), deferred downgrades
 * (take effect at cycle end, no refund).
 */
@Schema({ _id: false })
export class ProrationPolicy {
  /**
   * How an upgrade is priced.
   * `prorated` = charge only the difference for remaining days, keep renewal date.
   * `full_reset` = charge full new-plan price, restart billing cycle.
   */
  @Prop({ type: String, enum: ['prorated', 'full_reset'], default: 'prorated' })
  upgradeMode: string;

  /**
   * When a downgrade takes effect.
   * `cycle_end` = at end of current period (no refund).
   * `immediate`  = apply right away.
   */
  @Prop({ type: String, enum: ['cycle_end', 'immediate'], default: 'cycle_end' })
  downgradeMode: string;

  /**
   * On a prorated upgrade, credit the unused value of the current plan
   * against the new charge. When false the customer pays the full
   * delta without a credit offset.
   */
  @Prop({ default: true }) creditUnusedOnUpgrade: boolean;

  /**
   * Whether customers can self-serve downgrade at all. When false the
   * downgrade UI is hidden and the action is rejected at the API layer.
   */
  @Prop({ default: true }) allowDowngrade: boolean;

  /**
   * Floor for a prorated upgrade charge in paise. A computed net charge
   * below this amount is treated as 0 (free upgrade), preventing tiny
   * ₹0.01–₹1 Razorpay orders that generate support noise.
   */
  @Prop({ default: 0 }) minProratedChargePaise: number;
}

@Schema({ timestamps: true, collection: 'billingpolicies' })
export class BillingPolicy extends Document {
  /**
   * Singleton key — always 'global' for now. Future-proofs scoping if the
   * org ever wants per-tier or per-region policies.
   */
  @Prop({ type: String, required: true, unique: true, default: 'global' })
  scope: string;

  @Prop({ type: FailedPaymentRetryPolicy, default: () => ({}) })
  failedPaymentRetry: FailedPaymentRetryPolicy;

  @Prop({ type: GracePeriodPolicy, default: () => ({}) })
  gracePeriod: GracePeriodPolicy;

  @Prop({ type: TrialPolicy, default: () => ({}) })
  trial: TrialPolicy;

  @Prop({ type: MarketingPolicy, default: () => ({}) })
  marketing: MarketingPolicy;

  /** Governs upgrade/downgrade proration math — read by ProrationService. */
  @Prop({ type: ProrationPolicy, default: () => ({}) })
  proration: ProrationPolicy;

  /** Phone / email shown on the "Contact sales" CTA. */
  @Prop({ type: String })
  salesContactPhone?: string;

  @Prop({ type: String })
  salesContactEmail?: string;
}

export const BillingPolicySchema = SchemaFactory.createForClass(BillingPolicy);
