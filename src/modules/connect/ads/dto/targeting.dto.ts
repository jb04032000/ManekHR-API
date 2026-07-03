import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Shared targeting dimensions used by `CreateBoostDto` and
 * `AudienceEstimateDto`. An absent or empty array on any dimension means
 * "no restriction on that dimension" (broadest reach).
 *
 * Dimension names mirror `TargetingMatchSpec` in `ads/lib/targeting.ts`.
 */
export class TargetingDto {
  /** Restrict to specific role slugs (e.g. "karigar", "manager"). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  roles?: string[];

  /** Restrict to specific industry sector slugs (e.g. "textile", "weaving"). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  sectors?: string[];

  /** Restrict to specific district names (e.g. "Surat", "Ahmedabad"). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  districts?: string[];

  /** Restrict to specific company size buckets (e.g. "1-10", "11-50"). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  companySizes?: string[];

  /**
   * Maximum social-graph connection degree to include.
   * 1 = direct connections only, 2 = 2nd degree, 3 = 3rd degree.
   * Omit to include all degrees (no restriction).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  maxConnectionDegree?: number;
}
