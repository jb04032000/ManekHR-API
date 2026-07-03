import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for an admin referral clawback (`POST /admin/connect/referrals/:id/clawback`).
 * What: an optional free-text reason recorded in the audit `meta` of the clawback.
 * Cross-module links: consumed by ReferralAdminController -> ReferralService.clawback
 *   (which always sets rejectionReason:'manual_clawback'; this reason is the human note).
 * Watch: adminUserId is NEVER taken from the body -- it comes from req.user.sub.
 */
export class ReferralClawbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
