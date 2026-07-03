import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LISTING_CATEGORIES, type ListingCategory } from '../../marketplace/schemas/listing.schema';
import { POST_KINDS, type PostKind } from '../../feed/schemas/post.schema';
import { LISTING_SORTS, type ListingSort } from '../listing-search.helpers';

/**
 * Verticals the search endpoint accepts. `all` federates across every live
 * vertical (S1.5); `people` (S1.2) and `listings` (M1.4.2) narrow. Jobs (P5)
 * joins this enum + the registry + the federation list with no other code
 * change.
 */
export const CONNECT_SEARCH_TYPES = [
  'all',
  'people',
  'posts',
  'listings',
  'jobs',
  // SRCH-VERT-1: storefronts (shops) + company / institute pages join the union.
  // Each narrows to its own vertical; `all` federates across every live vertical.
  'storefronts',
  'pages',
] as const;
export type ConnectSearchType = (typeof CONNECT_SEARCH_TYPES)[number];

/** Company-page kind facet (the "Institutes" narrow / label). Pages vertical only. */
export const CONNECT_PAGE_KINDS = ['business', 'institute'] as const;
export type ConnectPageKindFilter = (typeof CONNECT_PAGE_KINDS)[number];

/** Coerce a repeated query param or a comma-separated string into a trimmed string[]. */
function toStringArray(value: unknown): string[] | undefined {
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  const out = entries
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Coerce a query-string flag (`'true'` / `'false'`) into a boolean. */
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value === '') return undefined;
  return value.toLowerCase() === 'true';
}

/** Coerce a numeric query-string value (Express gives a string). */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Query for `GET /connect/search`.
 *
 * `q` is optional: a blank or omitted term is valid (the search box fires
 * before the user types) and, with no facet set, resolves to `{ results: [] }`.
 * The facet params (`skills`, `district`, `openToWork`) drive candidate search
 * and also support a facet-only browse with a blank `q`. `SearchService` trims
 * and escapes the query, so no format constraint is needed here.
 */
export class SearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Vertical to search. Defaults to people; `all` federates in S1.5. */
  @IsOptional()
  @IsIn(CONNECT_SEARCH_TYPES)
  type?: ConnectSearchType;

  /** Skill facet. Accepts repeated params or a comma-separated list. */
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  skills?: string[];

  /** District / textile-hub facet; matched case-insensitively. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  /** Restrict to members open to work. Accepts `true` / `false`. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  openToWork?: boolean;

  /** "Find a Service" provider filter -> members with "Providing services" on. Accepts `true` / `false`. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  providingServices?: boolean;

  /** Post content-kind facet (text / photo / video / document / voice). Posts vertical only. */
  @IsOptional()
  @IsIn(POST_KINDS)
  kind?: PostKind;

  /** Listing category (textile-trade taxonomy). Drives the listings vertical. */
  @IsOptional()
  @IsIn(LISTING_CATEGORIES)
  category?: ListingCategory;

  /**
   * A SET of canonical category slugs to blend into ONE listings result (OR
   * semantics — a listing in ANY of these surfaces). Powers a multi-category
   * browse such as the web `/connect/services` page (show ALL service categories
   * at once) without forcing the buyer to pick a single one. Accepts repeated
   * params or a comma-separated list; each entry is trimmed + lowercased.
   * Generic — no category is special-cased on the BE; the caller passes the set.
   * Mirrors the single `category` filter; when BOTH are sent, `categoryIn` wins.
   * NOT bounded to {@link LISTING_CATEGORIES} so custom-term categories work, same
   * as the single `category` open-string filter at the service layer; capped at 40.
   */
  @IsOptional()
  @Transform(({ value }) => toStringArray(value)?.map((entry) => entry.toLowerCase()))
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  categoryIn?: string[];

  /** Lower bound on a listing's `priceMin` (rupees). Listings vertical only. */
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  @Min(0)
  priceMin?: number;

  /** Upper bound on a listing's `priceMin` (rupees). Listings vertical only. */
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  @Min(0)
  priceMax?: number;

  /** Canonical tag slugs to filter listings by. Accepts repeated params or a comma-separated list. */
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  tags?: string[];

  /** Page size for the ACTIVE single vertical's infinite scroll (listings tab,
   *  or the people tab — Phase 2). Applies to whichever single vertical is the
   *  focused `type=`; the `all` preview ignores it. Omitted -> the service
   *  default. */
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  @Min(1)
  @Max(48)
  limit?: number;

  /** Page offset (skip N) for the active single vertical. Pairs with `limit`.
   *  `@Max` is a deep-skip guard: it bounds the most-expensive `.skip()` a
   *  client can force (both listings and people are bounded, so 5000 is far past
   *  any real depth). */
  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  @Min(0)
  @Max(5000)
  offset?: number;

  /**
   * "Verified sellers only" toggle for the listings vertical. Accepts the same
   * `true` / `false` query-string form as `openToWork` (so the web sends
   * `?verified=true`). Only `true` narrows; `false` / omitted is the unfiltered
   * default.
   */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  verified?: boolean;

  /**
   * Result ordering for the listings vertical (the marketplace sort dropdown).
   * One of {@link LISTING_SORTS}; defaults to `recent` (newest first) when
   * omitted. `top_rated` is accepted but currently folds to `recent` server-side
   * (the seller rating is not yet denormalized onto the listing).
   */
  @IsOptional()
  @IsIn(LISTING_SORTS)
  sort?: ListingSort;

  /**
   * Company-page kind facet (SRCH-VERT-1) — the "Institutes" narrow / label.
   * Pages vertical only; `business` | `institute`. Omitted = both kinds.
   */
  @IsOptional()
  @IsIn(CONNECT_PAGE_KINDS)
  pageKind?: ConnectPageKindFilter;
}
