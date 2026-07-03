import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body for `POST /admin/connect/ads/campaigns/:id/reject`.
 * A mandatory rejection reason is stored on the campaign record and surfaced
 * to the advertiser so they can correct the creative.
 */
export class AdminRejectDto {
  /** Human-readable rejection reason shown to the advertiser. Required. */
  @IsString()
  @IsNotEmpty()
  reason: string;
}

/**
 * Body for `POST /admin/connect/ads/campaigns/:id/approve`.
 * An optional internal note is stored for audit purposes only; it is not
 * shown to the advertiser.
 */
export class AdminApproveDto {
  /** Internal admin note (audit trail only, not visible to advertisers). */
  @IsOptional()
  @IsString()
  note?: string;
}
