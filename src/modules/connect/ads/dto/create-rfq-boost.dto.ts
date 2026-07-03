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
 * Allowed objectives for an RFQ (quotation request) boost. An RFQ is either broad
 * `reach` (cpm) or `quotes` (cpc) -- the supplier analogue of a job's
 * `applications` / a listing's `inquiries`. A supplier "responds with a quote".
 */
export const RFQ_BOOST_OBJECTIVES = ['reach', 'quotes'] as const;
export type RfqBoostObjective = (typeof RFQ_BOOST_OBJECTIVES)[number];

/**
 * Body for `POST /connect/ads/boosts/rfq` -- promote one of the caller's open
 * requests-for-quote to suppliers. The advertiser is always the authenticated
 * Connect User (`req.user.sub`); the RFQ must be owned by the caller (buyer) and
 * `open` (both enforced in the service). When `targeting.sectors` is empty the
 * service defaults the audience to the RFQ's trade category so it reaches matching
 * suppliers by default.
 */
export class CreateRfqBoostDto {
  /** Mongo id of the RFQ to boost. */
  @IsString()
  @IsNotEmpty()
  rfqId: string;

  /** Campaign objective drives the bidding model and the CTA rendered on the ad. */
  @IsIn(RFQ_BOOST_OBJECTIVES)
  objective: RfqBoostObjective;

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

  /** Optional audience targeting spec (omit for the default category audience). */
  @IsOptional()
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting?: TargetingDto;
}
