import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query for `GET /connect/search/listings/recent` (the marketplace landing's
 * "recent products" rail). Previously raw `@Query('limit'|'offset')` strings with
 * the size clamped only inside the service; this DTO enforces the bound at the
 * edge. `limit` is clamped to [1, 60] (the service's own cap; default 30).
 * `offset` carries a deep-skip guard like the federated-search listings leg.
 */
export class RecentListingsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  offset?: number;
}
