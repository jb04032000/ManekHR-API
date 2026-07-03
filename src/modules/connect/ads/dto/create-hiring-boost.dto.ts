import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
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
 * Allowed objectives for a "hiring" boost. The ad unit is the advertiser's own
 * profile (hirer framing), so it is either broad `reach` (cpm) or `profile_visits`
 * (cpc, workers clicking through to the employer). No id field: the target is
 * always the caller's own profile (derived from the JWT). Profile/intent level --
 * no specific job post required (owner decision 2026-06-18).
 */
export const HIRING_BOOST_OBJECTIVES = ['reach', 'profile_visits'] as const;
export type HiringBoostObjective = (typeof HIRING_BOOST_OBJECTIVES)[number];

/**
 * Body for `POST /connect/ads/boosts/hiring` -- promote the caller's own hiring
 * status to workers. The advertiser is always the authenticated Connect User
 * (`req.user.sub`); the caller's `ConnectProfile.openTo.hiring` must be on
 * (enforced in the service, not here). When `targeting.roles` is empty the service
 * defaults the audience to worker roles so the boost reaches the right side.
 */
export class CreateHiringBoostDto {
  /** Campaign objective drives the bidding model and the CTA rendered on the ad. */
  @IsIn(HIRING_BOOST_OBJECTIVES)
  objective: HiringBoostObjective;

  /**
   * Total campaign budget in INR (whole rupees). The DTO enforces only a wide
   * guardrail floor; the real, admin-tunable minimum (default 99) is enforced in
   * BoostService against the live pricing config.
   */
  @IsNumber()
  @Min(BOOST_BUDGET_GUARDRAIL_MIN)
  totalBudget: number;

  /**
   * Campaign duration in days. Budget is spread evenly across the period. The DTO
   * enforces only the guardrail range; the allowed set is the live config
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

  /** Optional audience targeting spec (omit for the default worker audience). */
  @IsOptional()
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting?: TargetingDto;
}
