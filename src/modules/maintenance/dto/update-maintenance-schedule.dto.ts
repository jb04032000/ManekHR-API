import { PartialType } from '@nestjs/mapped-types';
import { CreateMaintenanceScheduleDto } from './create-maintenance-schedule.dto';

/**
 * UpdateMaintenanceScheduleDto (D-08).
 *
 * Body for `PATCH /workspaces/:wsId/machines/:machineId/maintenance/schedules/:id`.
 * All fields optional. Pause/resume goes through PauseScheduleDto (separate
 * endpoint) so this DTO intentionally omits `isActive`.
 */
export class UpdateMaintenanceScheduleDto extends PartialType(
  CreateMaintenanceScheduleDto,
) {}
