import { IsArray, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 2f multi-GSTIN: one additional state registration for a firm.
 * GSTIN is the 15-char format; stateCode is its leading 2-digit state code.
 */
export class FirmGstinEntryDto {
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/, {
    message: 'gstin must be a valid 15-character GSTIN',
  })
  gstin: string;

  @IsString()
  @Length(2, 2, { message: 'stateCode must be the 2-digit GST state code' })
  stateCode: string;

  @IsOptional()
  @IsString()
  label?: string;
}

export class UpdateFirmGstinsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FirmGstinEntryDto)
  additionalGstins: FirmGstinEntryDto[];
}
