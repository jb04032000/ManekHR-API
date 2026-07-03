import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Coupon code — discount applied to a subscription payment at checkout.
 *
 * Discount type:
 *   percentage      : `valueOrPaise` is a 0..100 integer percentage off.
 *   fixed_amount    : `valueOrPaise` is a flat ₹ amount (in paise) off.
 *   fixed_price     : `valueOrPaise` is the final price in paise (override).
 *
 * Scope:
 *   applicablePlanIds = [] → all catalogue plans.
 *   applicablePlanIds = [...] → only listed plans.
 *
 * Limits:
 *   maxRedemptions          → total redemptions across all users (null = ∞).
 *   maxRedemptionsPerUser   → per-user cap (null = ∞).
 *   isFirstTimeOnly         → only redeemable by users with zero prior payments.
 *   isStackable             → may stack with other stackable coupons in one cart.
 *   autoApplyCampaignKey    → URL `?promo=<key>` auto-applies this coupon.
 *
 * Validity window:
 *   validFrom / validUntil — both optional; absent = unbounded.
 */
@Schema({ timestamps: true, collection: 'coupons' })
export class Coupon extends Document {
  /** Public code the user types in. Case-insensitive lookup; stored uppercase. */
  @Prop({ type: String, required: true, unique: true, index: true })
  code: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ enum: ['percentage', 'fixed_amount', 'fixed_price'], required: true })
  discountType: string;

  /**
   * For percentage: integer 0..100.
   * For fixed_amount: flat discount in paise.
   * For fixed_price: target final price in paise (overrides plan price).
   */
  @Prop({ required: true })
  valueOrPaise: number;

  // ── Validity window ───────────────────────────────────────────────────
  @Prop({ type: Date })
  validFrom?: Date;

  @Prop({ type: Date })
  validUntil?: Date;

  // ── Redemption limits ─────────────────────────────────────────────────
  /** Total redemptions allowed across all users. null = unlimited. */
  @Prop({ type: Number, default: null })
  maxRedemptions?: number | null;

  /** Per-user cap. null = unlimited. */
  @Prop({ type: Number, default: 1 })
  maxRedemptionsPerUser?: number | null;

  /** Counter incremented atomically on each successful redemption. */
  @Prop({ default: 0 })
  redemptionsCount: number;

  // ── Eligibility flags ────────────────────────────────────────────────
  /** Only redeemable by users with zero successful prior subscription payments. */
  @Prop({ default: false })
  isFirstTimeOnly: boolean;

  /** Allow combining with another stackable coupon in the same checkout. */
  @Prop({ default: false })
  isStackable: boolean;

  /** Restrict to specific plans. Empty = all catalogue plans. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Plan' }], default: [] })
  applicablePlanIds: Types.ObjectId[];

  /** Restrict to specific billing cycles. Empty = all. */
  @Prop({ type: [String], default: [] })
  applicableBillingCycles: string[];

  // ── Auto-apply campaign ──────────────────────────────────────────────
  /** URL `?promo=<key>` auto-applies this coupon. Unique when set. */
  @Prop({ type: String, index: true, sparse: true })
  autoApplyCampaignKey?: string;

  // ── Lifecycle ─────────────────────────────────────────────────────────
  @Prop({ default: true })
  isActive: boolean;

  /** Admin user who created the coupon. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const CouponSchema = SchemaFactory.createForClass(Coupon);

// Lookup by code is the hot path; case-folded uppercase lookups.
CouponSchema.index({ code: 1, isActive: 1 });
