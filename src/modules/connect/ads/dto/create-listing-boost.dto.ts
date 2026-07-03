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

/**
 * Default campaign durations in days, used to seed the admin-tunable pricing
 * config and as the boost-composer fallback. The ALLOWED set is now the live
 * config (ConnectPricingConfig.boostDurations), enforced in BoostService -- so
 * the owner can add / remove durations without a deploy. The DTO only enforces
 * a wide guardrail range (1-365); the real business set lives in the config.
 */
export const BOOST_DAYS = [3, 7, 14, 30] as const;
export type BoostDays = (typeof BOOST_DAYS)[number];

/** Hard guardrail bounds for a single boost field (admin tunes within these). */
export const BOOST_DURATION_DAY_MIN = 1;
export const BOOST_DURATION_DAY_MAX = 365;
/** Hard guardrail floor for any boost budget; the real min is config-driven. */
export const BOOST_BUDGET_GUARDRAIL_MIN = 1;

/**
 * Allowed objectives for a listing boost. A listing has no profile, so the
 * post-only `profile_visits` objective is intentionally excluded: a listing
 * boost is either broad `reach` (cpm) or buyer `inquiries` (cpc, maps to the
 * marketplace inquiry / contact-unlock action).
 */
export const LISTING_BOOST_OBJECTIVES = ['reach', 'inquiries'] as const;
export type ListingBoostObjective = (typeof LISTING_BOOST_OBJECTIVES)[number];

/**
 * Body for `POST /connect/ads/boosts/listing` - boost a marketplace listing.
 *
 * The advertiser is always the authenticated Connect User (`req.user.sub`);
 * `ownerUserId` is never accepted from the body. The listing must be owned by
 * the caller and have `moderationStatus === 'approved'` (both enforced in the
 * service, not here). `targeting` absent or with empty dimension arrays = the
 * broadest possible reach.
 */
export class CreateListingBoostDto {
  /** Mongo id of the marketplace listing to boost. */
  @IsString()
  @IsNotEmpty()
  listingId: string;

  /** Campaign objective drives the bidding model and the CTA rendered on the ad. */
  @IsIn(LISTING_BOOST_OBJECTIVES)
  objective: ListingBoostObjective;

  /**
   * Total campaign budget in INR (whole rupees). The DTO only enforces a wide
   * guardrail floor; the real, admin-tunable minimum (default 99) is enforced
   * in BoostService against the live pricing config.
   */
  @IsNumber()
  @Min(BOOST_BUDGET_GUARDRAIL_MIN)
  totalBudget: number;

  /**
   * Campaign duration in days. Budget is spread evenly across the period. The
   * DTO only enforces the guardrail range (1-365); the allowed set is the live
   * config (BoostService enforces membership), so durations are deploy-free.
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
