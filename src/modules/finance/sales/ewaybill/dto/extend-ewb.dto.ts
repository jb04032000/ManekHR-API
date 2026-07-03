import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * ExtendEwbDto
 *
 * Body for PATCH /:invoiceId/extend.
 * Used to extend EWB validity within the ±8-hour window around validUpto.
 *
 * Extension reason codes per NIC:
 *   1 = Natural Calamity
 *   2 = Law and Order Situation
 *   3 = Transhipment
 *   4 = Accident
 *   5 = Other
 *   6 = In Transit
 *   7 = Vehicle Breakdown
 */
export class ExtendEwbDto {
  /** New vehicle registration number */
  @IsString()
  vehicleNo: string;

  /** Place where vehicle currently is (for extension from current location) */
  @IsString()
  fromPlace: string;

  /** State code of current vehicle location */
  @IsNumber()
  @Min(1)
  @Max(37)
  fromState: number;

  /** Remaining distance to destination in km */
  @IsNumber()
  @Min(1)
  remainDist: number;

  /**
   * Vehicle type:
   *   'R' = Regular
   *   'M' = Over-Dimensional Cargo
   */
  @IsIn(['R', 'M'])
  vehicleType: 'R' | 'M';

  /**
   * Transport mode:
   *   '1' = Road, '2' = Rail, '3' = Air, '4' = Ship
   */
  @IsIn(['1', '2', '3', '4'])
  transMode: '1' | '2' | '3' | '4';

  /**
   * Extension reason code (integer 1-7).
   */
  @IsInt()
  @Min(1)
  @Max(7)
  extnReason: number;

  /** New transport document number (optional for road; required for rail/air/ship) */
  @IsOptional()
  @IsString()
  transDocNo?: string;

  /** New transport document date (DD/MM/YYYY) */
  @IsOptional()
  @IsString()
  transDocDate?: string;
}
