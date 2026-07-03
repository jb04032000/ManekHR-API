import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Invoice layout config editor (design spec 2026-06-01 SS2C / 3B).
 * Five optional show/hide flags for the A4 web print themes.
 * Every flag is optional so the editor can PATCH a single key without
 * resending the full layout. The themes use `layout?.<flag> !== false`
 * so omitting a flag in storage keeps the section visible (safe default).
 * Gated by `finance.settings.manage` on the PATCH endpoint.
 */
export class UpdateInvoiceLayoutDto {
  @IsOptional()
  @IsBoolean()
  showHsnColumn?: boolean;

  @IsOptional()
  @IsBoolean()
  showDiscountColumn?: boolean;

  @IsOptional()
  @IsBoolean()
  showBankDetails?: boolean;

  @IsOptional()
  @IsBoolean()
  showSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  showTermsAndConditions?: boolean;
}
