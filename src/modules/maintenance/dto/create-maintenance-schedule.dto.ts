import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CADENCE_MODES,
  CadenceMode,
} from '../schemas/maintenance-schedule.schema';

/**
 * CreateMaintenanceScheduleDto (D-01, D-08).
 *
 * Body for `POST /workspaces/:wsId/machines/:machineId/maintenance/schedules`.
 *
 * Constraints mirror schema bounds verbatim so the validation pipe rejects
 * out-of-range values before reaching Mongo. `scheduleCode`, `anchorDate`
 * default, `nextDueAt`, `createdBy`, `updatedBy`, `workspaceId`, `machineId`
 * are set by the service layer (Plan 24-04) — clients MUST NOT supply them.
 */
export class CreateMaintenanceScheduleDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsEnum(CADENCE_MODES)
  cadenceMode!: CadenceMode;

  @IsInt()
  @Min(1)
  cadenceInterval!: number;

  @IsOptional()
  @IsMongoId()
  technicianId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  checklistItems?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  leadTimeDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  estimatedDurationMinutes?: number;

  @IsOptional()
  @IsMongoId()
  defaultDowntimeReasonCodeId?: string;

  // ISO 8601 — service parses to Date. Defaults to "now" if omitted.
  @IsOptional()
  @IsDateString()
  anchorDate?: string;
}
