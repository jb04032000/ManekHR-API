import { IsBoolean } from 'class-validator';

/**
 * PauseScheduleDto (D-08).
 *
 * Body for `PATCH /workspaces/:wsId/machines/:machineId/maintenance/schedules/:id/pause`.
 * `isActive: false` silences alerts without deleting the schedule;
 * `isActive: true` resumes alerts (and triggers nextDueAt re-compute).
 */
export class PauseScheduleDto {
  @IsBoolean()
  isActive!: boolean;
}
