import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Connect Referrals -- `ConnectReferralConfig` singleton.
 * What: platform-wide referral levers the admin tunes WITHOUT a deploy (credit
 *   per side, holdback, caps, velocity, master on/off).
 * Cross-module links: read by ReferralService (Phase 2) (qualify/release decisions) +
 *   referral-admin controller; written by AdminReferralController. Mirrors
 *   ConnectPricingConfig (single doc, key:'default', platform-wide, no workspaceId).
 * Watch: amounts are SNAPSHOTTED onto ConnectReferral at qualify time, so changing
 *   a value here never re-prices an already-qualified referral -- only future ones.
 */
@Schema({ timestamps: true, collection: 'connect_referral_configs' })
export class ConnectReferralConfig extends Document {
  @Prop({ type: String, required: true, unique: true, default: 'default' })
  key: string;

  /** Master on/off. Ships ON so a fresh deploy has the program live (not half-on);
   *  admin can still pause it anytime via the referral-admin controller. */
  @Prop({ type: Boolean, required: true, default: true })
  enabled: boolean;

  /** Credits the referrer earns per qualified referral (whole credits = rupees). */
  @Prop({ type: Number, required: true, default: 50, min: 0 })
  referrerCredits: number;

  /** Credits the new joiner earns. */
  @Prop({ type: Number, required: true, default: 50, min: 0 })
  refereeCredits: number;

  /** Days a qualified credit is held before it becomes spendable. */
  @Prop({ type: Number, required: true, default: 7, min: 0 })
  holdbackDays: number;

  /** Max REWARDED referrals per referrer, lifetime. 0 = unlimited. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  perReferrerCap: number;

  /** Max rewarded referrals per referrer per calendar month. 0 = unlimited. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  monthlyPerReferrerCap: number;

  /** Max referral credits a single user can EARN per financial year (194R guard). 0 = unlimited. */
  @Prop({ type: Number, required: true, default: 19000, min: 0 })
  annualCreditCeilingPerUser: number;

  /** Program-wide ceiling on total credits granted; auto-pause when hit. 0 = unlimited. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  totalBudgetCap: number;

  /** Max referrals attributed to one referrer per 24h. 0 = unlimited. */
  @Prop({ type: Number, required: true, default: 10, min: 0 })
  dailyVelocityPerReferrer: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectReferralConfigDocument = ConnectReferralConfig & Document;
export const ConnectReferralConfigSchema = SchemaFactory.createForClass(ConnectReferralConfig);

/** Shipped defaults (seed + fallback + test snapshot). Keep in sync with @Prop defaults. */
export const CONNECT_REFERRAL_DEFAULTS = {
  enabled: true,
  referrerCredits: 50,
  refereeCredits: 50,
  holdbackDays: 7,
  perReferrerCap: 0,
  monthlyPerReferrerCap: 0,
  annualCreditCeilingPerUser: 19000,
  totalBudgetCap: 0,
  dailyVelocityPerReferrer: 10,
} as const;

/** Public-safe read shape (no Mongo metadata). */
export interface ConnectReferralConfigView {
  enabled: boolean;
  referrerCredits: number;
  refereeCredits: number;
  holdbackDays: number;
  perReferrerCap: number;
  monthlyPerReferrerCap: number;
  annualCreditCeilingPerUser: number;
  totalBudgetCap: number;
  dailyVelocityPerReferrer: number;
}
