import { IsOptional, IsString, MaxLength, Matches, ValidateIf } from 'class-validator';

/**
 * Finance branding editor (design spec 2026-06-01-finance-billing-module-design
 * SS2C / SS6.A). Persists onto `Firm.brandProfile` (a free-form `Record<string,
 * any>` on the schema). The print themes
 * (`crewroster-web/lib/finance/print/themes/*`) already consume exactly these
 * keys via `FirmProfile.brandProfile`; this DTO is the FIRST writer.
 *
 * Every field is optional so the editor can PATCH a single key without
 * resending the whole profile. Colours are validated as 3- or 6-digit hex
 * (`#RGB` / `#RRGGBB`); the asset fields are validated as plain strings (they
 * hold URLs returned by the upload service, not user-typed). Text fields carry
 * length caps so an oversized footer / T&C cannot bloat the document or the
 * rendered PDF.
 *
 * A field sent as explicit `null` means "clear this brand value": the
 * `@ValidateIf` guard skips the string / hex validators for null so a cleared
 * colour does not trip hex validation, and the service translates the null to a
 * `$unset` on the stored `brandProfile`.
 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class UpdateFirmBrandingDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(2048)
  logoUrl?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(2048)
  signatureUrl?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(HEX_COLOR, { message: 'primaryColor must be a hex colour, e.g. #1A2A6C' })
  primaryColor?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(HEX_COLOR, { message: 'accentColor must be a hex colour, e.g. #C9A24B' })
  accentColor?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(500)
  footerText?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  termsAndConditions?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  declaration?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(100)
  upiId?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(120)
  bankName?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(40)
  bankAccountNumber?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(20)
  bankIfsc?: string | null;
}
