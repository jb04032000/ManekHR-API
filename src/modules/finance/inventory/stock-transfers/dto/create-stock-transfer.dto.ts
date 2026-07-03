import {
  IsArray,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StockTransferLineDto {
  @IsMongoId()
  itemId: string;

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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  narration?: string;
}

export class CreateStockTransferDto {
  @IsDateString()
  date: string;

  @IsMongoId()
  fromGodownId: string;

  @IsMongoId()
  toGodownId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockTransferLineDto)
  lines: StockTransferLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  narration?: string;
}
