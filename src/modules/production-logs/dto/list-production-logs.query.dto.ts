import {
  IsOptional,
  IsMongoId,
  IsBooleanString,
  IsInt,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListProductionLogsQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsMongoId()
  operatorId?: string;

  @IsOptional()
  @IsMongoId()
  shiftId?: string;

  @IsOptional()
  @IsMongoId()
  machineId?: string;

  @IsOptional()
  @IsBooleanString()
  includeDeleted?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
