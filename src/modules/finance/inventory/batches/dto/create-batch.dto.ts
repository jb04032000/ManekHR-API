import {
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateBatchDto {
  @IsMongoId()
  itemId: string;

  @IsString()
  @MaxLength(100)
  batchNo: string;

  @IsOptional()
  @IsDateString()
  mfgDate?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsNumber()
  @Min(0)
  qtyProduced: number;

  @IsMongoId()
  godownId: string;
}
