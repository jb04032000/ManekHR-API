import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';

export class JournalVoucherLineDto {
  @IsMongoId()
  accountId!: string;

  @IsInt()
  @Min(0)
  debitPaise!: number;

  @IsInt()
  @Min(0)
  creditPaise!: number;

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCentre?: string;
}

export class CreateJournalVoucherDto {
  @IsDateString()
  voucherDate!: string;

  @IsIn(['journal', 'contra'])
  voucherType!: 'journal' | 'contra';

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  narration!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalVoucherLineDto)
  @ArrayMinSize(2)
  lines!: JournalVoucherLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @IsOptional()
  @IsObject()
  recurringConfig?: {
    frequency: 'monthly' | 'quarterly';
    nextRunDate: string;
    endDate?: string;
  };
}
