import {
  IsString,
  IsDateString,
  IsNumber,
  Min,
  Max,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';

// Body for POST finance/gst-rate-history/revise (D15). Records a GST rate change for an
// HSN/SAC prefix effective from a date; the service end-dates the current open rate and
// inserts this one (no overlap, append-forward).
export class ReviseGstRateDto {
  // HSN/SAC prefix = 1-8 digits (longest-prefix match). Bounded so a junk/over-long prefix
  // can't pollute the platform-global rate table (D16 hardening).
  @IsString() @Matches(/^\d{1,8}$/) hsnPrefix: string;
  @IsDateString() fromDate: string;
  @IsNumber() @Min(0) @Max(100) cgstRate: number;
  @IsNumber() @Min(0) @Max(100) sgstRate: number;
  @IsNumber() @Min(0) @Max(100) igstRate: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) cessRate?: number;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(200) notification?: string;
}
