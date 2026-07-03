import { IsEnum, IsOptional, IsString, IsDateString } from 'class-validator';

export class AssetRegisterDto {
  @IsString() @IsOptional() financialYear?: string;
  @IsString() @IsOptional() categoryId?: string;
  @IsEnum(['active', 'disposed', 'scrapped', 'transferred', 'all']) @IsOptional() status?: string;
  @IsDateString() @IsOptional() asOfDate?: string;
}
