import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Coerce a query-string integer; non-numeric or absent becomes undefined. */
function toInt(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Query for `GET /connect/tags/trending`. */
export class TagTrendingQueryDto {
  /** Max tags (1-20). Defaults to 20 in the service. */
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
