import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * ListServiceLogsQueryDto (D-02 / D-08).
 *
 * Query string for `GET /workspaces/:wsId/machines/:machineId/maintenance/service-logs`.
 * Mirrors the shape of `ListDowntimeQueryDto` minus `status`; adds
 * `scheduleId` and `technicianId` filters per D-08.
 *
 * `from` / `to` are ISO date strings — service layer converts to a UTC
 * range using the workspace timezone (matching the Phase 22 pattern).
 */
export class ListServiceLogsQueryDto {
  @IsOptional()
  @IsMongoId()
  scheduleId?: string;

  @IsOptional()
  @IsMongoId()
  technicianId?: string;

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
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
