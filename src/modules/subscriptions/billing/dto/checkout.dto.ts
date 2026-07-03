import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCheckoutDto {
  @IsMongoId()
  planId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  /**
   * Customer-supplied coupon codes (D1e). Up to 5 per checkout.
   * Stacking rules enforced server-side: at most one fixed_price
   * coupon (non-stackable); stacking percentage / fixed_amount only
   * when every coupon has `isStackable=true`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(/^[A-Z0-9_-]{3,32}$/, { each: true })
  couponCodes?: string[];

  /**
   * Marketing-URL `?promo=<key>` value (D1e). If supplied AND no
   * `couponCodes`, server scans for a matching auto-apply coupon.
   * If `couponCodes` is supplied, this is ignored — explicit user
   * codes win.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  autoApplyCampaignKey?: string;
}

export class ConfirmPaymentDto {
  /**
   * Internal id of the `SubscriptionPayment` row created at /checkout time.
   * Returned to the client as `paymentId` from createOrder; client must
   * round-trip it back so we can locate the order without trusting the
   * gateway-supplied order id.
   */
  @IsMongoId()
  subscriptionPaymentId: string;

  @IsString()
  @MinLength(8)
  razorpayOrderId: string;

  @IsString()
  @MinLength(8)
  razorpayPaymentId: string;

  @IsString()
  @MinLength(8)
  razorpaySignature: string;
}
