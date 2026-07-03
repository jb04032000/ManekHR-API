import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * GenerateEwbDto
 *
 * Body for POST /:invoiceId/generate.
 * Transport details required to generate an e-Way Bill.
 */
export class GenerateEwbDto {
  /**
   * Transport mode:
   *   '1' = Road
   *   '2' = Rail
   *   '3' = Air
   *   '4' = Ship
   */
  @IsIn(['1', '2', '3', '4'])
  transMode: '1' | '2' | '3' | '4';

  /**
   * Transport distance in km (required for validity period calculation).
   * Validity = Math.ceil(distance / 200) days for road regular (current 2025 rule).
   */
  @IsNumber()
  @Min(1)
  transDistance: number;

  /** Vehicle registration number (required for road transport) */
  @IsOptional()
  @IsString()
  vehicleNo?: string;

  /**
   * Vehicle type:
   *   'R' = Regular
   *   'M' = Over-Dimensional Cargo (ODC) — uses 1 day per 20 km validity
   */
  @IsOptional()
  @IsIn(['R', 'M'])
  vehicleType?: 'R' | 'M';

  /** Transporter GSTIN / ID (optional — for when transporter is different from seller) */
  @IsOptional()
  @IsString()
  transporterId?: string;

  /** Transporter name */
  @IsOptional()
  @IsString()
  transporterName?: string;

  /** Transport document number (LR/RR/airway bill number) */
  @IsOptional()
  @IsString()
  transDocNo?: string;

  /** Transport document date (DD/MM/YYYY) */
  @IsOptional()
  @IsString()
  transDocDate?: string;

  /**
   * Override Gujarat textile intrastate exemption.
   * When true, generates EWB even if all items are in Gujarat textile HSN range.
   * Default: false (respect exemption).
   */
  @IsOptional()
  @IsBoolean()
  overrideExemption?: boolean;
}
