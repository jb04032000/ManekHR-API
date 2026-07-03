import { IsString, IsIn, IsOptional, IsNumber, IsBoolean, Matches, Length } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateItemDto {
  @IsString() name: string;
  @IsIn(['goods', 'services']) itemType: string;
  @IsString() unit: string;
  @IsOptional() @IsString() itemCode?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @Length(4, 8) @Matches(/^[0-9]+$/) hsnSacCode?: string;
  @IsOptional() @IsIn([0, 5, 12, 18, 28]) @Type(() => Number) gstRate?: number;
  @IsOptional() @Type(() => Number) @IsNumber() cessRate?: number;
  @IsOptional() @Type(() => Number) @IsNumber() qtyDecimalPlaces?: number;
  @IsOptional() @IsBoolean() trackBatch?: boolean;
  @IsOptional() @IsString() category?: string;
}
