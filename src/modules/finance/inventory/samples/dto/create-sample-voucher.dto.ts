import {
  IsArray,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SampleLineDto {
  @IsMongoId()
  itemId: string;

  @IsMongoId()
  godownId: string;

  @IsOptional()
  @IsMongoId()
  lotId?: string;

  @IsOptional()
  @IsMongoId()
  batchId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serialNos?: string[];

  @IsNumber()
  @Min(0)
  qty: number;

  /** Indicative rate per unit in paise */
  @IsOptional()
  @IsNumber()
  @Min(0)
  rate?: number;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class CreateSampleVoucherDto {
  @IsEnum(['sample', 'consignment'])
  sampleType: 'sample' | 'consignment';

  @IsDateString()
  date: string;

  @IsMongoId()
  partyId: string;

  @IsOptional()
  @IsString()
  deliveryAddress?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SampleLineDto)
  lines: SampleLineDto[];

  @IsDateString()
  expectedReturnDate: string;

  /** Days before expectedReturnDate to trigger alarm (defaults to 7) */
  @IsOptional()
  @IsNumber()
  @Min(1)
  autoAlarmDays?: number;

  @IsOptional()
  @IsString()
  narration?: string;
}
