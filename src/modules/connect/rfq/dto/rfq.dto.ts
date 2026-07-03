import { Transform, Type } from 'class-transformer';
import { IsGteField } from '../../common/validators/is-gte-field.validator';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { LISTING_CATEGORIES, LISTING_UNITS } from '../../marketplace/schemas/listing.schema';

class RfqLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;
}

/** Post a Request for Quote (buyer). */
export class CreateRfqDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /**
   * Trade category. One of the known LISTING_CATEGORIES slugs OR a custom term
   * (max 60). RfqService normalises it via TagService so custom values
   * self-register and stay canonical (mirrors create-listing + create-job
   * `category`). The board filter (RfqBoardQueryDto) stays preset-only.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  category!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsIn(LISTING_UNITS)
  unit?: (typeof LISTING_UNITS)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  budgetMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @IsGteField('budgetMin')
  budgetMax?: number;

  @IsOptional()
  @IsISO8601()
  neededBy?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RfqLocationDto)
  location?: RfqLocationDto;
}

/** A seller's quote on an RFQ. `price` is the TOTAL; `rate` x `rateQuantity`
 *  is the optional per-unit breakdown behind it. */
export class CreateQuoteDto {
  @IsInt()
  @Min(0)
  price!: number;

  /** Per-unit rate in rupees (the calculator's input). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  rate?: number;

  /** Quantity the rate covers. */
  @IsOptional()
  @IsInt()
  @Min(0)
  rateQuantity?: number;

  /** What the rate includes (preset slugs / short custom strings, max 6). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  includes?: string[];

  /** Offer validity in days (display-only). Omit = till the request closes. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  validityDays?: number;

  /** Work-sample photo URLs (max 5, uploaded via the shared uploads endpoint). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  sampleUrls?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  leadTimeDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  /** Optional: which of the seller's storefronts this quote is from. */
  @IsOptional()
  @IsMongoId()
  storefrontId?: string;
}

/**
 * Query params for the RFQ board (the filter rail + sort + search + paging).
 * Every field is optional; the bare board (no params) keeps prior behaviour.
 */
export class RfqBoardQueryDto {
  @IsOptional()
  @IsIn(LISTING_CATEGORIES)
  category?: (typeof LISTING_CATEGORIES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  /** Csv district multi-select (rail checklist). Supersedes `district`. */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  districts?: string;

  /** Csv status buckets: open | closing-soon | awarded (rail checklist). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  statuses?: string;

  /** With a budget filter set: also include "Negotiable" (no-budget) requests. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeNegotiable?: boolean;

  /** Only requests the caller has NO live quote on (viewer-scoped, service-built). */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  notQuotedByMe?: boolean;

  /** Only categories the caller supplies (their active listings; service-built). */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  matchedToMyWork?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsGteField('budgetMin')
  budgetMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  postedWithinDays?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeClosed?: boolean;

  @IsOptional()
  @IsIn(['recent', 'budget', 'closing'])
  sort?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  skip?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

/**
 * Query params for the board FACET counts (GET board/facets). Filter fields
 * only -- sort/limit/skip make no sense for counts and are rejected by the
 * global whitelist validation. Mirrors the jobs BoardFacetsQueryDto pattern.
 */
export class RfqBoardFacetsQueryDto {
  @IsOptional()
  @IsIn(LISTING_CATEGORIES)
  category?: (typeof LISTING_CATEGORIES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  districts?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  statuses?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeNegotiable?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  notQuotedByMe?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  matchedToMyWork?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsGteField('budgetMin')
  budgetMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  postedWithinDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
