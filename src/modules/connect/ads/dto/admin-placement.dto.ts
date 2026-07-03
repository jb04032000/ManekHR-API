import { IsBoolean, IsNumber, Min } from 'class-validator';

/**
 * Body for `PATCH /admin/connect/ads/placements/:key`.
 * Controls whether a placement slot is active and its auction floor price.
 */
export class AdminPlacementDto {
  /**
   * Floor CPM (cost per 1000 impressions) in INR paise.
   * Bids below this value are excluded from the auction.
   * 0 = no floor (any bid wins if it is the highest).
   */
  @IsNumber()
  @Min(0)
  floorCpm: number;

  /** Whether this placement slot accepts and serves ads. */
  @IsBoolean()
  enabled: boolean;
}
