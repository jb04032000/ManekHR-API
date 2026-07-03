import {
  IsMongoId,
  IsString,
  Matches,
  IsOptional,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';

/**
 * Phase 25 Plan 04 — Heatmap query DTO.
 *
 * Heatmap is bounded to a single calendar month (D-13) so the grid never
 * exceeds 31 columns. `month` MUST be YYYY-MM.
 */
export class HeatmapQueryDto {
  @IsMongoId()
  locationId!: string;

  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be YYYY-MM',
  })
  month!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  shiftIds?: string[];
}
