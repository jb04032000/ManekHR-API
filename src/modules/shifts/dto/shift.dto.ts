import {
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateShiftDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() startTime: string;
  @IsString() @IsNotEmpty() endTime: string;

  @IsArray() @IsNumber({}, { each: true }) @IsOptional() workingDays?: number[];
  @IsArray() @IsString({ each: true }) @IsOptional() weeklyOff?: string[];
  @IsString() @IsOptional() color?: string;
  @IsString() @IsOptional() colorBg?: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;

  @IsNumber() @IsOptional() gracePeriodMinutes?: number;

  // Phase C policy engine — the Shift schema has long carried these fields;
  // the DTO simply never exposed them. See attendance-completion plan P2b.
  // `@IsOptional()` skips validation on null too, so the web can clear
  // `requiredHoursPerDay` / `policyId` by sending null.
  @IsIn(['fixed', 'flexi', 'split', 'break'])
  @IsOptional()
  shiftType?: 'fixed' | 'flexi' | 'split' | 'break';

  @IsNumber() @IsOptional() halfDayAfterLateMinutes?: number;

  @IsNumber() @IsOptional() requiredHoursPerDay?: number | null;

  @IsMongoId() @IsOptional() policyId?: string | null;
}

export class UpdateShiftDto extends CreateShiftDto {}
