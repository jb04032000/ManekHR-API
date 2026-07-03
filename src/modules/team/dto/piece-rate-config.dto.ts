import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PIECE_RATE_UNITS,
  PieceRateUnit,
} from '../schemas/piece-rate-config.schema';

export class PerMachineRateOverrideDto {
  @IsMongoId()
  machineId: string;

  @IsNumber()
  @Min(0)
  rate: number;
}

export class SetPieceRateConfigDto {
  @IsEnum(PIECE_RATE_UNITS)
  unit: PieceRateUnit;

  @IsNumber()
  @Min(0)
  defaultRate: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  basePortion?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PerMachineRateOverrideDto)
  perMachineOverrides?: PerMachineRateOverrideDto[];

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsBoolean()
  includeStitchUnit?: boolean;
}

export class UpdatePieceRateConfigDto extends SetPieceRateConfigDto {}
