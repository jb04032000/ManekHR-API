import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class FailedPaymentRetryPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  retryIntervalDays?: number;
}

export class GracePeriodPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  durationDays?: number;

  @IsOptional()
  @IsBoolean()
  readOnlyMode?: boolean;

  @IsOptional()
  @IsBoolean()
  showContactSalesCta?: boolean;
}

export class TrialPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  defaultDurationDays?: number;

  @IsOptional()
  @IsBoolean()
  defaultCardRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  reminderEmailDaysBeforeEnd?: number;
}

/** D4 — marketing automation toggles. */
export class MarketingPolicyDto {
  @IsOptional()
  @IsBoolean()
  sendTrialReminder?: boolean;

  @IsOptional()
  @IsBoolean()
  sendRenewalNotice?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  renewalNoticeDaysBeforeEnd?: number;

  @IsOptional()
  @IsBoolean()
  sendWinBack?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  winBackAfterDays?: number;

  @IsOptional()
  @IsBoolean()
  sendAbandonedCheckout?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  abandonedCheckoutAfterHours?: number;
}

/** Admin-editable proration knobs — mirrors ProrationPolicy schema subdoc. */
export class ProrationPolicyDto {
  @IsOptional()
  @IsIn(['prorated', 'full_reset'])
  upgradeMode?: string;

  @IsOptional()
  @IsIn(['cycle_end', 'immediate'])
  downgradeMode?: string;

  @IsOptional()
  @IsBoolean()
  creditUnusedOnUpgrade?: boolean;

  @IsOptional()
  @IsBoolean()
  allowDowngrade?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minProratedChargePaise?: number;
}

export class UpdateBillingPolicyDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => FailedPaymentRetryPolicyDto)
  failedPaymentRetry?: FailedPaymentRetryPolicyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GracePeriodPolicyDto)
  gracePeriod?: GracePeriodPolicyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TrialPolicyDto)
  trial?: TrialPolicyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MarketingPolicyDto)
  marketing?: MarketingPolicyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProrationPolicyDto)
  proration?: ProrationPolicyDto;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  salesContactPhone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  salesContactEmail?: string;
}
