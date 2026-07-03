import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const HHMM_REGEX = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;

export class CreateMachineAssignmentDto {
  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsString()
  @IsNotEmpty()
  teamMemberId: string;

  @IsDateString()
  effectiveFrom: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @Matches(HHMM_REGEX, { message: 'startTime must be HH:mm (24h)' })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(HHMM_REGEX, { message: 'endTime must be HH:mm (24h)' })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

export class UpdateMachineAssignmentDto {
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @Matches(HHMM_REGEX, { message: 'startTime must be HH:mm (24h)' })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(HHMM_REGEX, { message: 'endTime must be HH:mm (24h)' })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}
