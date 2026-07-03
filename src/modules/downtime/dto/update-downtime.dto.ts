import {
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * UpdateDowntimeDto (D-06, D-08).
 *
 * Body for `PATCH /workspaces/:wsId/machines/:machineId/downtime/:id`.
 * All fields optional. Explicit `endAt: null` is permitted to reopen
 * a previously-closed entry (subject to overlap + edit-window guards).
 */
export class UpdateDowntimeDto {
  @IsOptional()
  @IsMongoId()
  reasonCodeId?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  // Explicit null ⇒ reopen (clears endAt + durationMinutes server-side).
  @IsOptional()
  @IsDateString()
  endAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
