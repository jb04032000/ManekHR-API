import {
  IsOptional,
  IsDateString,
  IsArray,
  ArrayMaxSize,
  IsMongoId,
} from 'class-validator';

/**
 * Phase 25 Plan 04 — Trend query DTO.
 *
 * The machineId is a path param on the controller (Plan 09); this DTO covers
 * additional query params for the per-machine trend page. Granularity is
 * server-derived from range span (D-11) — no user toggle.
 */
export class TrendQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  shiftIds?: string[];
}
