import {
  IsDateString,
  IsMongoId,
  IsOptional,
  IsInt,
  IsString,
  MinLength,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class VoidEventDto {
  @IsString()
  @MinLength(3, { message: 'Reason must be at least 3 characters' })
  @MaxLength(280, { message: 'Reason must be at most 280 characters' })
  reason: string;
}

export class RecomputeAttendanceDto {
  @IsOptional()
  @IsMongoId()
  memberId?: string;

  @IsDateString()
  from: string; // YYYY-MM-DD or ISO

  @IsDateString()
  to: string;
}

export class ListEventsQueryDto {
  @IsOptional()
  @IsMongoId()
  memberId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
