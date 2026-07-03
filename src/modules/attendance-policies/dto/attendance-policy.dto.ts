import {
  IsString, IsBoolean, IsNumber, IsOptional, MinLength,
  ValidateNested, IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

class LateArrivalDto {
  @IsBoolean() @IsOptional() countAsLop?: boolean;
  @IsNumber() @IsOptional() lopAfterNLateDays?: number | null;
}

class EarlyDepartureDto {
  @IsBoolean() @IsOptional() enabled?: boolean;
  @IsNumber() @IsOptional() thresholdMinutes?: number;
  @IsBoolean() @IsOptional() countAsHalfDay?: boolean;
}

class OtDto {
  @IsBoolean() @IsOptional() enabled?: boolean;
  @IsNumber() @IsOptional() thresholdMinutes?: number;
  @IsNumber() @IsOptional() capMinutes?: number | null;
}

class CompOffDto {
  @IsBoolean() @IsOptional() enabled?: boolean;
}

export class CreateAttendancePolicyDto {
  @IsString() @MinLength(1) name: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;
  @ValidateNested() @Type(() => LateArrivalDto) @IsOptional() lateArrival?: LateArrivalDto;
  @ValidateNested() @Type(() => EarlyDepartureDto) @IsOptional() earlyDeparture?: EarlyDepartureDto;
  @ValidateNested() @Type(() => OtDto) @IsOptional() ot?: OtDto;
  @ValidateNested() @Type(() => CompOffDto) @IsOptional() compOff?: CompOffDto;
}

export class UpdateAttendancePolicyDto {
  @IsString() @IsOptional() @MinLength(1) name?: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;
  @ValidateNested() @Type(() => LateArrivalDto) @IsOptional() lateArrival?: LateArrivalDto;
  @ValidateNested() @Type(() => EarlyDepartureDto) @IsOptional() earlyDeparture?: EarlyDepartureDto;
  @ValidateNested() @Type(() => OtDto) @IsOptional() ot?: OtDto;
  @ValidateNested() @Type(() => CompOffDto) @IsOptional() compOff?: CompOffDto;
}

class DateRangeDto {
  @IsString() from: string; // ISO date string: YYYY-MM-DD
  @IsString() to: string;
}

export class DryRunDto {
  @ValidateNested() @Type(() => DateRangeDto) dateRange: DateRangeDto;
  @IsArray() @IsString({ each: true }) @IsOptional() scope?: string[]; // memberId[] filter
}
