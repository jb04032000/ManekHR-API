import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Create-mandate request — kicks off Razorpay Subscriptions API flow.
 * Returns a `short_url` the user opens to authorise the eMandate / UPI /
 * card debit. The local Subscription is created in `pending` status and
 * flips to `active` when the `subscription.activated` webhook arrives.
 */
export class CreateMandateDto {
  @IsMongoId()
  planId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  /**
   * Optional override for the number of billing cycles. Defaults from
   * `Plan.recurringTotalCount<Cycle>` if set, else 120 (monthly) / 50
   * (yearly). Razorpay caps total_count at the plan's billing-period
   * limits — this DTO accepts 1..1200.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1200)
  totalCount?: number;

  /**
   * Customer-supplied coupon codes (D1e). Discount applies to the
   * FIRST CYCLE ONLY for mandate flows — Razorpay Subscriptions API
   * binds a single price per Plan, so the discount is realised by
   * lazy-mirroring a discounted Razorpay Plan for cycle 1, then
   * scheduling an automatic plan change to the standard plan from
   * cycle 2 onwards via Razorpay's `subscription.update` with
   * `schedule_change_at='cycle_end'`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(/^[A-Z0-9_-]{3,32}$/, { each: true })
  couponCodes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  autoApplyCampaignKey?: string;
}

/** Self-serve cancel — defaults to cancel-at-cycle-end (user keeps paid period). */
export class CancelMandateDto {
  @IsOptional()
  @IsBoolean()
  cancelAtCycleEnd?: boolean;
}

export class PauseMandateDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

/**
 * Admin variants — same actions, but accept a `userId` so the caller
 * acts on behalf of a target user. Service layer enforces admin scope
 * via guard; DTO just accepts the extra field.
 */
export class AdminCreateMandateDto extends CreateMandateDto {
  @IsMongoId()
  userId: string;
}

export class AdminCancelMandateDto extends CancelMandateDto {
  @IsMongoId()
  userId: string;
}

export class AdminPauseMandateDto extends PauseMandateDto {
  @IsMongoId()
  userId: string;
}

export class AdminResumeMandateDto {
  @IsMongoId()
  userId: string;
}
