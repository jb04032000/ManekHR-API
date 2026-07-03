import { IsInt, IsMongoId, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query params for GET /workspaces/:wsId/salary/piece-rate/preview
 *
 * Phase 23 (D-06 / RESEARCH §7) — preview endpoint live recompute.
 * `month` is 1-indexed (1=Jan ... 12=Dec); `year` is the 4-digit calendar year.
 */
export class PreviewPieceRateQueryDto {
  @IsMongoId()
  teamMemberId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;
}
