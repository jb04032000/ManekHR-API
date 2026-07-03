import {
  IsString,
  IsObject,
  IsOptional,
  MaxLength,
  Matches,
} from 'class-validator';

/**
 * UpdateGstr3bAdjustmentDto — payload for PATCH /gstr3b/adjustments.
 *
 * adjustments: map of cell-key → paise integer overrides.
 * Cell-key format: "3.1.a.igst", "3.2.24.unreg.txval", "4A.3.cgst", etc.
 * Full allowlist validated server-side in Gstr3bService.validateAdjustments().
 *
 * Values stored in paise (non-negative integers).
 * T-12-W3-15 mitigation: unknown cell keys are rejected before persistence.
 */
export class UpdateGstr3bAdjustmentDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'period must be MMYYYY format (6 digits, e.g. 042025)' })
  period: string;

  /**
   * Map of GSTR-3B cell key → paise value (integer).
   * Example: { "3.1.a.igst": 120000, "4A.3.cgst": 60000 }
   *
   * Full cell-key allowlist is validated in Gstr3bService.validateAdjustments().
   * Non-integer or negative values are rejected with BadRequestException.
   */
  @IsObject()
  adjustments: Record<string, number>;

  /**
   * Optional narration / reason for the manual adjustment (T-12-W3-18: audit trail).
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  narration?: string;
}
