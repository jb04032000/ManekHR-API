import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TargetingDto } from './targeting.dto';
import {
  BOOST_BUDGET_GUARDRAIL_MIN,
  BOOST_DURATION_DAY_MAX,
  BOOST_DURATION_DAY_MIN,
} from './create-listing-boost.dto';

/**
 * Allowed objectives for a job boost. A job has no profile, so `profile_visits`
 * is excluded: a job boost is either broad `reach` (cpm) or `applications`
 * (cpc, the job analogue of a listing's `inquiries`).
 */
export const JOB_BOOST_OBJECTIVES = ['reach', 'applications'] as const;
export type JobBoostObjective = (typeof JOB_BOOST_OBJECTIVES)[number];

/**
 * Body for `POST /connect/ads/boosts/job` - boost a job (Phase 5).
 *
 * The advertiser is always the authenticated Connect User (`req.user.sub`);
 * `ownerUserId` is never accepted from the body. The job must be owned by the
 * caller and `open` (both enforced in the service). `targeting` absent or with
 * empty dimension arrays = the broadest possible reach.
 */
export class CreateJobBoostDto {
  /** Mongo id of the job to boost. */
  @IsString()
  @IsNotEmpty()
  jobId: string;

  /** Campaign objective drives the bidding model and the CTA on the ad. */
  @IsIn(JOB_BOOST_OBJECTIVES)
  objective: JobBoostObjective;

  /**
   * Total campaign budget in INR (whole rupees). The DTO enforces only a wide
   * guardrail floor; the real, admin-tunable minimum (default 99) is enforced
   * in BoostService against the live pricing config.
   */
  @IsNumber()
  @Min(BOOST_BUDGET_GUARDRAIL_MIN)
  totalBudget: number;

  /**
   * Campaign duration in days. Budget is spread evenly across the period. The
   * DTO enforces only the guardrail range; the allowed set is the live config
   * (BoostService enforces membership), so durations are deploy-free.
   */
  @IsInt()
  @Min(BOOST_DURATION_DAY_MIN)
  @Max(BOOST_DURATION_DAY_MAX)
  days: number;

  /** Phase 2: optional Spotlight premium upgrade (also serves the premium right-rail). */
  @IsOptional()
  @IsBoolean()
  spotlight?: boolean;

  /** Optional audience targeting spec (omit for the broadest reach). */
  @IsOptional()
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting?: TargetingDto;
}
