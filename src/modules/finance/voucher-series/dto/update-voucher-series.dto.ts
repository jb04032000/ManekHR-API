import { IsInt, IsOptional, IsString, MaxLength, Min, Max } from 'class-validator';

/**
 * Custom invoice numbering editor (2026-06-01).
 * Allows the workspace owner / HR to customise the prefix, padding width,
 * and start number for each voucher series. All fields are optional so a
 * partial PATCH can update a single key without resending the whole document.
 *
 * Gated by `finance.settings.manage` (Owner/HR only by preset).
 * generateNextNumber and the schema are NOT touched by this DTO.
 */
export class UpdateVoucherSeriesDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  padDigits?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  startNumber?: number;
}
