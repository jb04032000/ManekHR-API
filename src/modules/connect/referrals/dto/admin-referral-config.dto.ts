import { IsBoolean, IsInt, Min } from 'class-validator';

/**
 * Admin write shape for ConnectReferralConfig.
 * What: body for PUT /admin/connect/referrals/config; shape + loose floor only.
 * Cross-module links: consumed by AdminReferralController ->
 *   ConnectReferralConfigService. Real bounds (caps, ceilings) enforced in the
 *   service's validate() so they are centralised and unit-testable.
 * Watch: keep field names in sync with ConnectReferralConfig schema + ConnectReferralConfigView.
 */
export class AdminReferralConfigDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(0) referrerCredits: number;
  @IsInt() @Min(0) refereeCredits: number;
  @IsInt() @Min(0) holdbackDays: number;
  @IsInt() @Min(0) perReferrerCap: number;
  @IsInt() @Min(0) monthlyPerReferrerCap: number;
  @IsInt() @Min(0) annualCreditCeilingPerUser: number;
  @IsInt() @Min(0) totalBudgetCap: number;
  @IsInt() @Min(0) dailyVelocityPerReferrer: number;
}
