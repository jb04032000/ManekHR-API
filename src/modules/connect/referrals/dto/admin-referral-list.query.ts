import { IsIn, IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { ReferralStatus } from '../schemas/connect-referral.schema';

/**
 * Query shape for the admin referral log (`GET /admin/connect/referrals`).
 * What: optional status filter + optional referrer filter + pagination, validated
 *   and coerced (query strings -> numbers) before reaching ReferralService.listReferrals.
 * Cross-module links: consumed by ReferralAdminController -> ReferralService.listReferrals.
 * Watch: keep `status` in sync with the ReferralStatus union; page/pageSize floors
 *   are re-clamped in the service too (defence in depth).
 */
export class AdminReferralListQuery {
  @IsOptional()
  @IsIn(['pending', 'qualified', 'rewarded', 'rejected'])
  status?: ReferralStatus;

  @IsOptional()
  @IsMongoId()
  referrerUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
