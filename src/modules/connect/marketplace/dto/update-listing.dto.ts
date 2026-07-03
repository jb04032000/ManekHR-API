import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
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
  LISTING_PRICE_TYPES,
  LISTING_UNITS,
  NEW_SERVICE_CATEGORIES,
  type ListingPriceType,
  type ListingUnit,
} from '../schemas/listing.schema';
import {
  CourseDetailsDto,
  ListingLocationDto,
  ListingSpecDto,
  ListingTradeTermsDto,
  ListingVideoDto,
  ServiceDetailsDto,
} from './create-listing.dto';

/** Plain string[] of the 8 NEW service categories for the patch `@ValidateIf` gate. */
const NEW_SERVICE_CATEGORY_SET: string[] = [...NEW_SERVICE_CATEGORIES];

/**
 * Patch-listing payload: every content field optional. Lifecycle transitions
 * (publish / pause) and moderation are NOT set here -- they have dedicated
 * endpoints + the admin moderation console (M1.3).
 */
export class UpdateListingDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

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
   * Product video(s), capped at one. On update the service grandfathers a video
   * already on the listing (its url/posterUrl stay valid without a fresh
   * ownership record) and only ownership-checks a newly-added clip; durationSec
   * is re-derived server-side. Omit to leave the existing video unchanged.
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
   * Course detail. On a patch this is REQUIRED only when the patch explicitly
   * sets `category === 'course'` (the `@ValidateIf` gate); for any other patch
   * (including one that leaves the category untouched) it is optional, so an edit
   * to a non-course field never has to resend it. Pass it to update the course
   * fields; the service merges it onto the existing listing.
   */
  @ValidateIf((o: UpdateListingDto) => o.category === 'course')
  @IsDefined()
  @ValidateNested()
  @Type(() => CourseDetailsDto)
  courseDetails?: CourseDetailsDto;

  /**
   * Service detail. On a patch this is REQUIRED only when the patch explicitly
   * sets `category` to one of the 8 NEW_SERVICE_CATEGORIES (the `@ValidateIf`
   * gate); for any other patch (including one that leaves the category
   * untouched) it is optional, so an edit to a non-service field never has to
   * resend it. Pass it to update the service fields; the service merges it onto
   * the existing listing. Mirrors `courseDetails`.
   */
  @ValidateIf((o: UpdateListingDto) => NEW_SERVICE_CATEGORY_SET.includes(o.category ?? ''))
  @IsDefined()
  @ValidateNested()
  @Type(() => ServiceDetailsDto)
  serviceDetails?: ServiceDetailsDto;
}
