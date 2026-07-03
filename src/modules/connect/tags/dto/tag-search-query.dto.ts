import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Coerce a query-string integer; non-numeric or absent becomes undefined. */
function toInt(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Query for `GET /connect/tags/search`, tag autocomplete. */
export class TagSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  q?: string;

  /** Max suggestions (1-10). Defaults to 10 in the service. */
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}
