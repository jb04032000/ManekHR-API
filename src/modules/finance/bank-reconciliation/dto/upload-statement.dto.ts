import { IsOptional, IsString, IsInt, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class GenericColumnMappingDto {
  @IsString()
  dateColumn: string;

  @IsString()
  narrationColumn: string;

  @IsOptional()
  @IsString()
  debitColumn?: string;

  @IsOptional()
  @IsString()
  creditColumn?: string;

  @IsOptional()
  @IsString()
  amountColumn?: string;

  @IsOptional()
  @IsString()
  drCrFlagColumn?: string;

  @IsOptional()
  @IsString()
  refNumberColumn?: string;

  @IsOptional()
  @IsString()
  balanceColumn?: string;

  @IsOptional()
  @IsString()
  valueDateColumn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  headerRowIndex?: number;
}

export class ConfirmStatementDto {
  // The buffer key returned from upload-preview - server reads file from temporary cache.
  // For F-13 simplicity: client re-uploads file with this DTO. Multipart preserved.

  @IsOptional()
  @IsString()
  detectedFormat?: string; // override server detection

  @IsOptional()
  @ValidateNested()
  @Type(() => GenericColumnMappingDto)
  genericMapping?: GenericColumnMappingDto;
}
