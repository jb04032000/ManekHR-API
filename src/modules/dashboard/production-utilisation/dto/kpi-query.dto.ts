import {
  IsOptional,
  IsDateString,
  IsArray,
  ArrayMaxSize,
  IsMongoId,
} from 'class-validator';

/**
 * Phase 25 Plan 04 — KPI query DTO.
 *
 * Per-field validation:
 *   - from / to: ISO date strings (YYYY-MM-DD accepted by IsDateString).
 *   - machineIds / locationIds: ObjectId arrays capped at 200 (D-28).
 *   - shiftIds: ObjectId array capped at 50 (workspaces have far fewer
 *     shifts than machines; tighter cap is defence-in-depth).
 *
 * Range-span validation (≤ 365 days, D-27) is enforced in the service layer
 * via `assertRangeWithin365Days()` because class-validator can't easily
 * cross-reference two fields.
 */
export class KpiQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  locationIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  shiftIds?: string[];
}
