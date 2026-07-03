import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** GSTIN format: `<state-code><PAN><entity><Z><checksum>` — 15 chars total. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** Indian PIN code: 6 digits, can't start with 0. */
const PINCODE_RE = /^[1-9][0-9]{5}$/;

/**
 * Self-serve billing-profile update (D1f).
 *
 * All fields optional — partial update. When `gstin` is supplied, the
 * server validates against GST format AND derives `stateCode` from the
 * first 2 digits if `stateCode` is not also supplied (or asserts they
 * match if both are supplied — surface the mismatch instead of
 * silently overriding).
 */
export class UpdateBillingProfileDto {
  @IsOptional()
  @IsString()
  @Matches(GSTIN_RE, { message: 'gstin must be a valid 15-char GSTIN' })
  gstin?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  state?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2, { message: 'stateCode must be the 2-digit GST state code' })
  stateCode?: string;

  @IsOptional()
  @IsString()
  @Matches(PINCODE_RE, { message: 'pincode must be a 6-digit Indian PIN' })
  pincode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;
}
