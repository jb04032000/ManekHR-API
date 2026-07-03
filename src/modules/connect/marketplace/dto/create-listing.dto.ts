import { Type } from 'class-transformer';
import { IsGteField } from '../../common/validators/is-gte-field.validator';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  LISTING_COURSE_FEE_TYPES,
  LISTING_COURSE_MODES,
  LISTING_PRICE_TYPES,
  LISTING_SERVICE_DELIVERY_MODES,
  LISTING_SERVICE_PRICING_MODELS,
  LISTING_UNITS,
  NEW_SERVICE_CATEGORIES,
  type ListingCourseFeeType,
  type ListingCourseMode,
  type ListingPriceType,
  type ListingServiceDeliveryMode,
  type ListingServicePricingModel,
  type ListingUnit,
} from '../schemas/listing.schema';

/**
 * The 8 NEW service categories as a plain string[] for the `@ValidateIf` gate
 * below. A listing in one of these REQUIRES `serviceDetails` (mirrors how
 * `course` requires `courseDetails`); the pre-existing service-ish categories
 * (`job-work` / `dyeing` / `printing` / `embroidery-zari`) are deliberately
 * NOT in this set, so they keep their current optional behavior.
 */
const NEW_SERVICE_CATEGORY_SET: string[] = [...NEW_SERVICE_CATEGORIES];

/** One specification row (label/value) for the detail-page spec grid. */
export class ListingSpecDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;
}

/** Off-platform trade terms (dispatch / payment / returns). All optional prose. */
export class ListingTradeTermsDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  dispatch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  payment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  returns?: string;
}

/**
 * One product video. Mirrors the feed `PostMediaDto` video hardening: `url` +
 * optional `posterUrl` are both https-only on OUR storage (the service runs them
 * through the media-ownership guard); `durationSec` is NOT accepted from the body
 * (the service derives it server-side from the owned upload record), so a client
 * cannot forge a clip length.
 */
export class ListingVideoDto {
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  posterUrl?: string;
}

/** Seller / work location. All parts optional (a service listing may be location-agnostic). */
export class ListingLocationDto {
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

/**
 * Course detail for a `category === 'course'` listing (Institutes Phase 1).
 * `durationLabel`, `mode`, and `feeType` are REQUIRED (a course needs them to be
 * useful); the rest are optional. The fee uses the listing's `priceMin` /
 * `priceMax` (driven by `feeType`), so no fee fields live here. `@ValidateIf` on
 * `CreateListingDto.courseDetails` makes the whole object required only when the
 * category is `course`, so a non-course listing never has to send it.
 */
export class CourseDetailsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  durationLabel: string;

  @IsOptional()
  @IsDateString()
  batchStart?: string;

  @IsIn([...LISTING_COURSE_MODES])
  mode: ListingCourseMode;

  @IsIn([...LISTING_COURSE_FEE_TYPES])
  feeType: ListingCourseFeeType;

  @IsOptional()
  @IsInt()
  @Min(0)
  seats?: number;

  @IsOptional()
  @IsBoolean()
  certificate?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @ArrayMaxSize(20)
  skillsTaught?: string[];
}

/**
 * Service detail for a service listing (Slice B1). `deliveryMode` and
 * `pricingModel` are REQUIRED (a service needs them to be useful); the rest are
 * optional context. The fee uses the listing's `priceMin` / `priceMax` (driven
 * by `pricingModel`), so no fee fields live here — exactly like `CourseDetailsDto`.
 * `@ValidateIf` on `CreateListingDto.serviceDetails` makes the whole object
 * required only when the category is one of the 8 NEW_SERVICE_CATEGORIES, so a
 * non-service listing never has to send it.
 */
export class ServiceDetailsDto {
  @IsIn([...LISTING_SERVICE_DELIVERY_MODES])
  deliveryMode: ListingServiceDeliveryMode;

  @IsIn([...LISTING_SERVICE_PRICING_MODELS])
  pricingModel: ListingServicePricingModel;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  coverageArea?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  yearsExperience?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  availability?: string;
}

/**
 * Create-listing payload. `ownerUserId` is NEVER accepted from the body -- it is
 * always derived from the JWT in the controller, so cross-user creation is
 * impossible.
 */
export class CreateListingDto {
  @IsString()
  @MaxLength(160)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /**
   * Category for this listing. Any of the 8 known LISTING_CATEGORIES slugs OR
   * a custom term (max 60 chars). The service normalises it via TagService so
   * custom values self-register and stay canonical (same machinery as `tags`).
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  category: string;

  @IsOptional()
  @IsIn([...LISTING_PRICE_TYPES])
  priceType?: ListingPriceType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsGteField('priceMin')
  priceMax?: number;

  @IsOptional()
  @IsIn([...LISTING_UNITS])
  unit?: ListingUnit;

  @IsOptional()
  @IsInt()
  @Min(0)
  moq?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  leadTimeDays?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingLocationDto)
  location?: ListingLocationDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  // Each image must be an https URL (the media-ownership guard further checks
  // it is on our storage and uploaded by the caller).
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @ArrayMaxSize(10)
  images?: string[];

  /**
   * Product video(s). Capped at ONE (`@ArrayMaxSize(1)`) - the listing carries a
   * single short clip; the array shape leaves room for "multiple videos" later
   * without a payload change. Each url + posterUrl is ownership-checked by the
   * service; durationSec is server-derived (never trusted from the body).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ListingVideoDto)
  @ArrayMaxSize(1)
  videos?: ListingVideoDto[];

  /** Raw seller-entered terms; the service resolves them to canonical slugs. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @ArrayMaxSize(8)
  tags?: string[];

  /** Specification rows for the detail-page spec grid. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ListingSpecDto)
  @ArrayMaxSize(12)
  specs?: ListingSpecDto[];

  /** Off-platform trade terms shown on the detail-page rail. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingTradeTermsDto)
  tradeTerms?: ListingTradeTermsDto;

  /**
   * Course detail. REQUIRED when `category === 'course'` (the `@ValidateIf` gate
   * below makes the field mandatory then, and `CourseDetailsDto`'s own decorators
   * require durationLabel / mode / feeType); IGNORED for any other category (a
   * non-course listing may omit it). This is how "DTO requires course fields when
   * category is course" is enforced without a separate custom validator.
   */
  @ValidateIf((o: CreateListingDto) => o.category === 'course')
  @IsDefined()
  @ValidateNested()
  @Type(() => CourseDetailsDto)
  courseDetails?: CourseDetailsDto;

  /**
   * Service detail. REQUIRED when `category` is one of the 8 NEW_SERVICE_CATEGORIES
   * (the `@ValidateIf` gate makes the field mandatory then, and `ServiceDetailsDto`'s
   * own decorators require deliveryMode / pricingModel); IGNORED for any other
   * category — including the pre-existing service-ish categories (`job-work` /
   * `dyeing` / `printing` / `embroidery-zari`), which keep their current optional
   * behavior (no behavior change). Mirrors exactly how `courseDetails` is gated.
   */
  @ValidateIf((o: CreateListingDto) => NEW_SERVICE_CATEGORY_SET.includes(o.category))
  @IsDefined()
  @ValidateNested()
  @Type(() => ServiceDetailsDto)
  serviceDetails?: ServiceDetailsDto;

  /**
   * OPTIONAL storefront to file this product under. Must be one the caller owns
   * (the service ownership-checks it). Omit to let the service resolve / create
   * the caller's default shop -- so a single-shop seller never has to pick.
   */
  @IsOptional()
  @IsMongoId()
  storefrontId?: string;

  /**
   * Save off-market as a `draft` instead of going live. The seller publishes it
   * later from "My listings". Omitted / false -> the listing goes live on create
   * (subject to moderation when enabled).
   */
  @IsOptional()
  @IsBoolean()
  asDraft?: boolean;
}
