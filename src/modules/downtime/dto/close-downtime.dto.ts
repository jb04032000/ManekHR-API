import { IsDateString, IsOptional } from 'class-validator';

/**
 * CloseDowntimeDto (D-06, D-08).
 *
 * Body for `PATCH /workspaces/:wsId/machines/:machineId/downtime/:id/close`.
 * `endAt` absent ⇒ server defaults to `new Date()` (now).
 */
export class CloseDowntimeDto {
  @IsOptional()
  @IsDateString()
  endAt?: string;
}
