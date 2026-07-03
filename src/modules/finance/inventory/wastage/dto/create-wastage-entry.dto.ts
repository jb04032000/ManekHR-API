import {
  IsArray,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WASTAGE_REASON_CODES } from '../wastage-entry.schema';

export class WastageEntryLineDto {
  @IsMongoId()
  itemId: string;

  @IsOptional()
  @IsMongoId()
  lotId?: string;

  @IsOptional()
  @IsMongoId()
  batchId?: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsEnum(['own_goods', 'job_work_material'])
  wastageType: 'own_goods' | 'job_work_material';

  @IsEnum(WASTAGE_REASON_CODES)
  reasonCode: (typeof WASTAGE_REASON_CODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class CreateWastageEntryDto {
  @IsDateString()
  date: string;

  @IsMongoId()
  godownId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WastageEntryLineDto)
  lines: WastageEntryLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  narration?: string;
}
