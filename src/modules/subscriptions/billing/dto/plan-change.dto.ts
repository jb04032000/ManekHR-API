import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * Customer-facing change-plan DTOs (Task 4).
 *
 * Three-step flow, mirroring the checkout DTOs in `checkout.dto.ts`:
 *   1. preview  — `PreviewPlanChangeDto`  → a `PlanChangeQuote` (no writes)
 *   2. execute  — `ExecutePlanChangeDto`  → either a Razorpay order (upgrade
 *                 with a net charge), an in-place apply (free upgrade /
 *                 lateral), or a scheduled downgrade row.
 *   3. confirm  — `ConfirmPlanChangeDto`  → verifies the signed Razorpay
 *                 payload for an upgrade order and applies the plan change.
 */

/**
 * Preview / execute share the same shape — both name the target plan, the
 * target billing cycle, and any coupon codes. The server recomputes the
 * proration quote from scratch on execute, so a preview is purely advisory.
 */
export class PreviewPlanChangeDto {
  /** Plan the customer wants to move to. */
  @IsMongoId()
  targetPlanId: string;

  /** Billing cycle for the target plan. Lifetime is not a valid target. */
  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  /**
   * Optional customer-supplied coupon codes. Up to 5; same character
   * constraints as checkout. Only the `discountOnBasePaise` effect is
   * honoured for a plan change (see `PlanChangeService.previewPlanChange`).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(/^[A-Z0-9_-]{3,32}$/, { each: true })
  couponCodes?: string[];
}

/** Identical shape to {@link PreviewPlanChangeDto}; kept distinct for clarity. */
export class ExecutePlanChangeDto {
  @IsMongoId()
  targetPlanId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(/^[A-Z0-9_-]{3,32}$/, { each: true })
  couponCodes?: string[];
}

/**
 * Confirm an upgrade proration charge. The client round-trips the
 * `SubscriptionPayment` id returned by execute plus the Razorpay
 * checkout-sheet signed payload.
 */
export class ConfirmPlanChangeDto {
  /**
   * Internal id of the `SubscriptionPayment` row created at execute time
   * (returned to the client as `subscriptionPaymentId`).
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
