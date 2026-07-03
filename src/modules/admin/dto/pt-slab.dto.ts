import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PtSlabEntryDto {
  @IsNumber()
  minSalary: number;

  @IsNumber()
  @IsOptional()
  maxSalary: number | null;

  @IsNumber()
  ptAmount: number;
}

export class CreatePtSlabDto {
  @IsString()
  state: string;

  @IsEnum(['monthly', 'annual'])
  frequency: 'monthly' | 'annual';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PtSlabEntryDto)
  slabs: PtSlabEntryDto[];
}

export class UpdatePtSlabDto {
  @IsEnum(['monthly', 'annual'])
  @IsOptional()
  frequency?: 'monthly' | 'annual';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PtSlabEntryDto)
  @IsOptional()
  slabs?: PtSlabEntryDto[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
