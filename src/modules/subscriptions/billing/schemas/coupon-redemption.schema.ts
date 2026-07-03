import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One row per coupon redemption. Created at checkout-confirm time after
 * payment is captured. Provides:
 *   - per-user enforcement of `maxRedemptionsPerUser`.
 *   - global counter for `maxRedemptions` (also incremented on the Coupon).
 *   - attribution analytics (which campaigns drive how much revenue).
 *
 * If a payment is later refunded, the redemption row stays — refunds are
 * tracked separately on `SubscriptionPayment.refunds[]`. If the org wants to
 * "give back" a coupon use after a refund, an admin tool reversing the
 * redemption can be added later; for now redemptions are immutable.
 */
@Schema({ timestamps: true, collection: 'couponredemptions' })
export class CouponRedemption extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Coupon', required: true, index: true })
  couponId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'SubscriptionPayment',
    required: true,
  })
  subscriptionPaymentId: Types.ObjectId;

  /** Snapshot of the discount in paise at redemption time. */
  @Prop({ required: true })
  discountAppliedPaise: number;

  /** Snapshot of the coupon code at redemption time (for display). */
  @Prop({ type: String, required: true })
  code: string;
}

export const CouponRedemptionSchema =
  SchemaFactory.createForClass(CouponRedemption);

// Per-user redemption limit enforcement.
CouponRedemptionSchema.index({ userId: 1, couponId: 1 });
