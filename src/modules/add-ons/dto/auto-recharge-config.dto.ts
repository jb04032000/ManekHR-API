import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Wave 7 — user-controlled auto-recharge config on
 * `subscription.appliedEntitlements.communications.*`.
 *
 * Threshold values capped at 100k to avoid pathological cron pressure.
 * Pack slugs validated as `[a-z0-9-]+` to keep payload tight.
 */
export class UpdateAutoRechargeConfigDto {
  @IsOptional()
  @IsBoolean()
  autoRechargeEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  autoRechargeThresholdSms?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  autoRechargeThresholdWhatsapp?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-]*$/)
  autoRechargeSmsPackSlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-]*$/)
  autoRechargeWhatsappPackSlug?: string;
}
