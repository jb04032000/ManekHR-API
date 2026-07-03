import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query-param validation for the Institutes Phase 2 (Feature 3) PUBLIC
 * institute-page reads (alumni / placements). These back `@Public()` routes, so
 * the DTO is the first line of input hardening for logged-out callers.
 *
 * What this does:
 *  - `AlumniQuery` validates the cursor-pagination params for the Alumni /
 *    Open-to-work tab: an opaque keyset `cursor` (decoded leniently by the
 *    service - a malformed value just restarts paging) and a `limit` clamped to
 *    [1, 50] (the service re-clamps via `clampPageSize`, so this is the API-edge
 *    backstop).
 *  - `PlacementQuery` validates the placement-wall `limit`. The wall is not
 *    keyset-paginated (it returns the full grouped set), so the service caps its
 *    scan with the shared `LIST_HARD_CAP` DoS backstop; this `limit` is honoured
 *    as a REAL cap that can only LOWER that scan, never raise it past the ceiling.
 *
 * Cross-module links: `cursor` is the shared Connect keyset cursor
 * (`modules/connect/common/keyset-cursor.ts`); `limit` mirrors that helper's
 * `MAX_PAGE_SIZE` ceiling. Keep the bounds in sync with `clampPageSize`.
 */
export class AlumniQuery {
  /** Opaque keyset cursor (base64url). Absent on the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  /** Page size, clamped to [1, 50]. Defaults to 20 in the service. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PlacementQuery {
  /** Real cap on the placement-wall scan, clamped to [1, 50]; the service lowers
   *  its LIST_HARD_CAP scan to this when provided (never above the hard ceiling). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
