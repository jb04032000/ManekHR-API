import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, Min } from 'class-validator';

/**
 * Body for `PUT /admin/connect/ads/pricing`.
 *
 * Class-validator here only enforces SHAPE + a loose `>= 0` floor; the real
 * business guardrails (sane bid / budget / duration bounds) live in
 * ConnectPricingConfigService.validateWithinGuardrails so the bounds are
 * centralised and unit-testable. Cross-module link: consumed by
 * AdsAdminController -> ConnectPricingConfigService.
 */
export class AdminPricingConfigDto {
  @IsNumber()
  @Min(0)
  boostBidCpm: number;

  @IsNumber()
  @Min(0)
  boostBidCpc: number;

  /** Premium multiplier for the Spotlight upgrade (bid x this on the rail). */
  @IsNumber()
  @Min(1)
  spotlightMultiplier: number;

  @IsNumber()
  @Min(0)
  boostMinBudget: number;

  /** Flat admin review fee (rupees) withheld from a take-down refund. */
  @IsInt()
  @Min(0)
  moderationReviewFee: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsNumber({}, { each: true })
  boostDurations: number[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsNumber({}, { each: true })
  boostBudgetPresets: number[];

  @IsNumber()
  @Min(0)
  walletTopupMinAmount: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsNumber({}, { each: true })
  walletTopupPresets: number[];
}
