import {
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * CreateDowntimeDto (D-06, D-08).
 *
 * Body for `POST /workspaces/:wsId/machines/:machineId/downtime`.
 * `endAt` absent ⇒ open downtime (server keeps it null).
 */
export class CreateDowntimeDto {
  @IsMongoId()
  reasonCodeId!: string;

  // ISO 8601 — service parses to Date.
  @IsDateString()
  startAt!: string;

  // null/absent ⇒ open downtime; service keeps endAt null.
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
