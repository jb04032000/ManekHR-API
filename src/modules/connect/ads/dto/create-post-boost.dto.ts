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
 * Allowed objectives for a post boost. A post HAS an author profile, so the
 * post-specific `profile_visits` (cpc, clicks to the author) is valid here in
 * addition to broad `reach` (cpm). The listing-only `inquiries` is excluded.
 */
export const POST_BOOST_OBJECTIVES = ['reach', 'profile_visits'] as const;
export type PostBoostObjective = (typeof POST_BOOST_OBJECTIVES)[number];

/**
 * Body for `POST /connect/ads/boosts/post` - boost one of the caller's own feed
 * posts. The advertiser is always the authenticated Connect User (`req.user.sub`);
 * `ownerUserId` is never accepted from the body. The post must be authored by the
 * caller, live, and `public` (all enforced in the service, not here -- see
 * `BoostService.createPostBoost`). Binds to the live `feed_promoted_post` slot.
 */
export class CreatePostBoostDto {
  /** Mongo id of the feed post to boost. */
  @IsString()
  @IsNotEmpty()
  postId: string;

  /** Campaign objective drives the bidding model and the CTA rendered on the ad. */
  @IsIn(POST_BOOST_OBJECTIVES)
  objective: PostBoostObjective;

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

  /**
   * Optional audience targeting spec. Omitting this field (or supplying an
   * object with only empty arrays) results in the broadest possible reach.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting?: TargetingDto;
}
