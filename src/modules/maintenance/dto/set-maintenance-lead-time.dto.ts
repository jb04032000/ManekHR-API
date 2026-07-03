import { IsInt, Max, Min } from 'class-validator';

/**
 * SetMaintenanceLeadTimeDto (D-08, D-10).
 *
 * Body for `PATCH /workspaces/:wsId/maintenance/lead-time` (owner-only).
 * Sets the workspace-default lead time used as a fallback when a schedule
 * does not specify its own `leadTimeDays`. Default is 7 days.
 */
export class SetMaintenanceLeadTimeDto {
  @IsInt()
  @Min(1)
  @Max(30)
  leadTimeDays!: number;
}
