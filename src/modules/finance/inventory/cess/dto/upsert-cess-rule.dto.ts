import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpsertCessRuleDto {
  /** 2–8 digit HSN prefix */
  @IsString()
  hsnCode: string;

  @IsString()
  description: string;

  @IsEnum(['ad_valorem', 'specific', 'compound'])
  cessType: 'ad_valorem' | 'specific' | 'compound';

  /** Percentage rate for ad_valorem and compound types */
  @IsOptional()
  @IsNumber()
  @Min(0)
  adValoremRate?: number;

  /** Paise per unit for specific and compound types */
  @IsOptional()
  @IsNumber()
  @Min(0)
  specificRatePerUnit?: number;

  @IsOptional()
  @IsEnum(['piece', 'kg', 'ml', 'liter', 'tonne'])
  specificRateUnit?: string;

  @IsDateString()
  applicableFrom: string;

  @IsOptional()
  @IsDateString()
  applicableTo?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
