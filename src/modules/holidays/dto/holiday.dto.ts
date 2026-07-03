import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsBoolean,
  IsOptional,
  IsIn,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateHolidayDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsDateString()
  date: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsIn(['national', 'festival', 'company', 'other'])
  @IsOptional()
  type?: 'national' | 'festival' | 'company' | 'other';
}

/**
 * Bulk-create payload. Lets an owner declare a whole year's calendar in one
 * request (e.g. national holidays imported from a template) instead of N
 * single-create round-trips. `@Type` + `@ValidateNested({ each: true })` runs
 * each element through the same CreateHolidayDto rules; the array bounds keep a
 * single request from inserting an unbounded batch (1..100, mirrors the
 * holidays-write throttle tier sizing).
 */
export class BulkCreateHolidaysDto {
  @ValidateNested({ each: true })
  @Type(() => CreateHolidayDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  holidays: CreateHolidayDto[];
}

export class UpdateHolidayDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsDateString()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsIn(['national', 'festival', 'company', 'other'])
  @IsOptional()
  type?: 'national' | 'festival' | 'company' | 'other';
}
