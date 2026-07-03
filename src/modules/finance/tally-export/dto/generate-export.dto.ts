import {
  IsArray,
  IsISO8601,
  IsMongoId,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * GenerateExportDto — POST /workspaces/:wsId/firms/:firmId/tally-export body.
 *
 * Server-side guards:
 *   - firmId must be a valid Mongo ObjectId.
 *   - fromDate / toDate must be ISO-8601 strings.
 *   - assertSameFy() runs in the service layer (single fiscal year per export).
 */
export class GenerateExportDto {
  @IsMongoId()
  firmId!: string;

  @IsISO8601()
  fromDate!: string;

  @IsISO8601()
  toDate!: string;

  /**
   * Optional voucher-type filter. Empty/null = all voucher classes.
   * Values match `LedgerEntry.sourceVoucherType` (e.g. 'sale_invoice').
   */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  voucherTypes?: string[];

  /**
   * Optional override for `<SVCURRENTCOMPANY>`. Defaults to firm.firmName.
   */
  @IsString()
  @IsOptional()
  companyNameOverride?: string;
}
