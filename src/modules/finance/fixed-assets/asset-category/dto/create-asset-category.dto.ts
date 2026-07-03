import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateAssetCategoryDto {
  @IsString() @MaxLength(120) name: string;
  @IsString() @MaxLength(500) @IsOptional() description?: string;
  @IsString() accountCode: string;
  @IsEnum(['slm', 'wdv']) depreciationMethod: 'slm' | 'wdv';
  @IsNumber() @Min(0) @Max(1) slmRate: number;
  @IsNumber() @Min(0) @Max(1) wdvRate: number;
  @IsNumber() @Min(1) @Max(100) usefulLifeYears: number;
  @IsNumber() @Min(0) @Max(1) @IsOptional() residualValuePct?: number;
  @IsString() @IsOptional() itActBlock?: string;
  @IsNumber() @Min(0) @Max(1) @IsOptional() itActRate?: number;
  @IsString() @IsOptional() scheduleIIRef?: string;
  @IsBoolean() @IsOptional() isNesd?: boolean;
}
