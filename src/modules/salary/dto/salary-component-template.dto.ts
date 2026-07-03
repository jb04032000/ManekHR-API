import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

const CALC_MODES = [
  'percent_of_ctc',
  'percent_of_component',
  'fixed',
  'balancing',
] as const;

export class SalaryComponentDefDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(CALC_MODES)
  calcMode: string;

  @IsNumber()
  @IsOptional()
  value?: number;

  @IsString()
  @IsOptional()
  referenceComponentId?: string;

  @IsBoolean()
  @IsOptional()
  includedInCtc?: boolean;

  @IsBoolean()
  @IsOptional()
  isBasicComponent?: boolean;

  @IsBoolean()
  @IsOptional()
  isTaxable?: boolean;

  @IsNumber()
  sortOrder: number;
}

export class CreateSalaryComponentTemplateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalaryComponentDefDto)
  components: SalaryComponentDefDto[];

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateSalaryComponentTemplateDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SalaryComponentDefDto)
  components?: SalaryComponentDefDto[];

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class SeedComponentTemplateDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['simple', 'standard_india', 'ctc_with_pf'])
  templateKey: string;
}
