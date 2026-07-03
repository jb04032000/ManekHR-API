import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ── grant ───────────────────────────────────────────────────────────

export class AdminGrantSubscriptionDto {
  @IsMongoId()
  userId: string;

  @IsMongoId()
  planId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

// ── extend ──────────────────────────────────────────────────────────

export class AdminExtendPeriodDto {
  @IsInt()
  @Min(1)
  @Max(3650)
  additionalDays: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

// ── override ────────────────────────────────────────────────────────

export class AdminOverrideEntitlementsDto {
  @IsObject()
  override: Record<string, unknown>;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

// ── manual payment ──────────────────────────────────────────────────

export class AdminManualPaymentDto {
  @IsMongoId()
  userId: string;

  @IsMongoId()
  planId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  @IsInt()
  @Min(1)
  amountPaise: number;

  @IsIn(['cheque', 'neft', 'cash', 'wire', 'other'])
  paymentMethod: 'cheque' | 'neft' | 'cash' | 'wire' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(60)
  receiptNumber?: string;

  @IsOptional()
  @IsString()
  paymentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

// ── pause / resume / force-cancel ──────────────────────────────────

export class AdminPauseDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;

  @IsOptional()
  @IsString()
  resumeAt?: string;
}

export class AdminResumeDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

export class AdminForceCancelDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsBoolean()
  immediate?: boolean;
}

// ── payment-link ───────────────────────────────────────────────────

export class AdminIssuePaymentLinkDto {
  @IsMongoId()
  userId: string;

  @IsMongoId()
  planId: string;

  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  @IsOptional()
  @IsInt()
  @Min(1)
  amountOverridePaise?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(90 * 24 * 3600)
  expireInSeconds?: number;
}

export class AdminPaymentLinkListQueryDto {
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @IsOptional()
  @IsIn(['created', 'captured', 'failed'])
  status?: 'created' | 'captured' | 'failed';

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

// ── custom-plan CRUD ───────────────────────────────────────────────

export class AdminCreateCustomPlanDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(40)
  tier: string;

  @IsInt()
  @Min(0)
  monthlyPrice: number;

  @IsInt()
  @Min(0)
  yearlyPrice: number;

  @IsOptional()
  @IsMongoId()
  assignedUserId?: string;

  @IsOptional()
  @IsMongoId()
  assignedWorkspaceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsOptional()
  @IsObject()
  entitlements?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDurationDays?: number;

  @IsOptional()
  @IsBoolean()
  trialCardRequired?: boolean;

  // Task 3 — optional/configurable subscription-plan GST. `false` drops GST
  // for this custom plan (defaults ON at the schema level).
  @IsOptional()
  @IsBoolean()
  gstEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isPriceTaxInclusive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  gstRatePercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sacCode?: string;

  @IsOptional()
  @IsBoolean()
  supportsAutoRenew?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsOneTime?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1200)
  recurringTotalCountMonthly?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1200)
  recurringTotalCountYearly?: number;
}

export class AdminUpdateCustomPlanDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  yearlyPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsOptional()
  @IsObject()
  entitlements?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDurationDays?: number;

  @IsOptional()
  @IsBoolean()
  trialCardRequired?: boolean;

  // Task 3 — optional/configurable subscription-plan GST (see create DTO).
  @IsOptional()
  @IsBoolean()
  gstEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isPriceTaxInclusive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  gstRatePercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sacCode?: string;

  @IsOptional()
  @IsBoolean()
  supportsAutoRenew?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsOneTime?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1200)
  recurringTotalCountMonthly?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1200)
  recurringTotalCountYearly?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AdminCustomPlanListQueryDto {
  @IsOptional()
  @IsMongoId()
  assignedUserId?: string;

  @IsOptional()
  @IsMongoId()
  assignedWorkspaceId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

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
