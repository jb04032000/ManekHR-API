import {
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLotDto {
  @IsMongoId()
  itemId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotNo?: string; // auto-generated if omitted

  @IsDateString()
  inwardDate: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsDateString()
  mfgDate?: string;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsOptional()
  @IsMongoId()
  sourceVoucherId?: string;

  @IsOptional()
  @IsString()
  sourceVoucherType?: string;

  @IsNumber()
  @Min(0)
  qtyInward: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @IsOptional()
  @IsEnum(['g', 'kg'])
  weightUnit?: 'g' | 'kg';

  @IsMongoId()
  godownId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
