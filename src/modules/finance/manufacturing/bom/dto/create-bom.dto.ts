import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class BomComponentDto {
  @IsMongoId()
  itemId: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsString()
  unit: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  wastageAllowedPct?: number;

  @IsOptional()
  @IsBoolean()
  isSubAssembly?: boolean;

  @IsOptional()
  @IsMongoId()
  subBomId?: string;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class BomByProductDto {
  @IsMongoId()
  itemId: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsString()
  unit: string;

  @IsNumber()
  @Min(0)
  nrvPaisePerUnit: number;
}

export class CreateBomDto {
  @IsMongoId()
  finishedItemId: string;

  @IsNumber()
  @Min(0)
  outputQty: number;

  @IsString()
  outputUnit: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  yieldPct?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BomComponentDto)
  components: BomComponentDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BomByProductDto)
  byProducts?: BomByProductDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  additionalCostEstimate?: number;

  @IsOptional()
  @IsString()
  narration?: string;
}
