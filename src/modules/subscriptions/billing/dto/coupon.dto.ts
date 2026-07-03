import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const DISCOUNT_TYPES = ['percentage', 'fixed_amount', 'fixed_price'] as const;
type DiscountType = (typeof DISCOUNT_TYPES)[number];

const BILLING_CYCLES = ['monthly', 'yearly', 'lifetime'] as const;

/** Public coupon code shape — uppercase alphanumerics + dash + underscore, 3..32 chars. */
const COUPON_CODE_RE = /^[A-Z0-9_-]{3,32}$/;

export class CreateCouponDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(COUPON_CODE_RE, {
    message:
      'code must be 3..32 chars, uppercase alphanumeric / dash / underscore',
  })
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsEnum(DISCOUNT_TYPES)
  discountType: DiscountType;

  /**
   * Percentage: integer 1..100.
   * Fixed amount: positive paise.
   * Fixed price: positive paise (final price including GST).
   */
  @IsInt()
  @Min(1)
  valueOrPaise: number;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptionsPerUser?: number;

  @IsOptional()
  @IsBoolean()
  isFirstTimeOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  isStackable?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  applicablePlanIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(BILLING_CYCLES, { each: true })
  applicableBillingCycles?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  autoApplyCampaignKey?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCouponDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsOptional()
  @IsEnum(DISCOUNT_TYPES)
  discountType?: DiscountType;

  @IsOptional()
  @IsInt()
  @Min(1)
  valueOrPaise?: number;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptionsPerUser?: number;

  @IsOptional()
  @IsBoolean()
  isFirstTimeOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  isStackable?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  applicablePlanIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(BILLING_CYCLES, { each: true })
  applicableBillingCycles?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  autoApplyCampaignKey?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CouponListQueryDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Self-serve preview — validate coupon codes for a planned checkout
 * without committing. Returns the discount breakdown so the UI can
 * show "you saved ₹X" before the user clicks pay.
 */
export class ValidateCouponDto {
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(COUPON_CODE_RE, { each: true })
  codes: string[];

  @IsMongoId()
  planId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';
}
