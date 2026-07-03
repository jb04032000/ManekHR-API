import {
  IsString,
  IsIn,
  IsOptional,
  IsNumber,
  IsDateString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// Principal place of business / per-registration address. All parts optional so
// a partial profile saves cleanly; `stateCode` is the 2-digit GST code.
export class FirmAddressDto {
  @IsOptional() @IsString() line1?: string;
  @IsOptional() @IsString() line2?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() stateCode?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() country?: string;
}

export class CreateFirmDto {
  @IsString() firmName: string;
  @IsIn(['trading', 'manufacturing', 'service', 'composition', 'textile']) businessType: string;
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, {
    message: 'Invalid GSTIN format',
  })
  gstin?: string;
  @IsOptional() @IsString() pan?: string;
  @IsOptional() @Type(() => Number) @IsNumber() fyStartMonth?: number;
  @IsOptional() @IsDateString() accountsBooksBeginDate?: string;
  @IsOptional() @IsString() state?: string;

  // Principal place of business + contact (rendered on invoices). Persisted on
  // the Firm; the Business Profile settings page and onboarding wizard write
  // these. Nested address is validated structurally.
  @IsOptional() @ValidateNested() @Type(() => FirmAddressDto) address?: FirmAddressDto;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() contactEmail?: string;
  @IsOptional() @IsString() website?: string;
}
