import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  IsArray,
} from 'class-validator';

/**
 * Query-param DTO for the 3 analytics endpoints that accept a month + year.
 * Uses `@Type(() => Number)` so the global ValidationPipe (with
 * `transformOptions: { enableImplicitConversion: false }`) coerces the raw
 * query strings to numbers before the class-validator decorators run.
 * ParseInt(NaN) is replaced at the controller boundary by a 400 from the pipe.
 */
export class MonthYearQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

/**
 * Query-param DTO for the absence-patterns endpoint.
 * `months` is optional with a default of 3 (last 3 months).
 */
export class LookbackMonthsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  months?: number;
}

export class MarkAttendanceDto {
  @IsMongoId() @IsNotEmpty() teamMemberId: string;
  @IsDateString() @IsNotEmpty() date: string;
  @IsEnum(['present', 'absent', 'half_day', 'late', 'on_leave', 'holiday', 'week_off'])
  status: string;
  @IsDateString() @IsOptional() checkIn?: string;
  @IsDateString() @IsOptional() checkOut?: string;
  @IsString() @IsOptional() note?: string;
}

export class BulkMarkAttendanceDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarkAttendanceDto)
  records: MarkAttendanceDto[];
}

export class UpdateAttendanceDto {
  @IsEnum(['present', 'absent', 'half_day', 'late', 'on_leave', 'holiday', 'week_off'])
  @IsOptional()
  status?: string;
  @IsDateString() @IsOptional() checkIn?: string;
  @IsDateString() @IsOptional() checkOut?: string;
  @IsString() @IsOptional() note?: string;
}
