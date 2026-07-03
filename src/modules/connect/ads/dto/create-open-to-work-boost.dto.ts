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
 * Allowed objectives for an "open to work" boost. The ad unit is the advertiser's
 * own profile, so it is either broad `reach` (cpm) or `profile_visits` (cpc,
 * employers clicking through to the worker). No id field: the target is always
 * the caller's own profile (derived from the JWT).
 */
export const OPEN_TO_WORK_BOOST_OBJECTIVES = ['reach', 'profile_visits'] as const;
export type OpenToWorkBoostObjective = (typeof OPEN_TO_WORK_BOOST_OBJECTIVES)[number];

/**
 * Body for `POST /connect/ads/boosts/open-to-work` -- promote the caller's own
 * profile to employers. The advertiser is always the authenticated Connect User
 * (`req.user.sub`); the caller's `ConnectProfile.openTo.work` must be on (enforced
 * in the service, not here). When `targeting.roles` is empty the service defaults
 * the audience to employer roles so the boost reaches the right side by default.
 */
export class CreateOpenToWorkBoostDto {
  /** Campaign objective drives the bidding model and the CTA rendered on the ad. */
  @IsIn(OPEN_TO_WORK_BOOST_OBJECTIVES)
  objective: OpenToWorkBoostObjective;

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

  /** Optional audience targeting spec (omit for the default employer audience). */
  @IsOptional()
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting?: TargetingDto;
}
