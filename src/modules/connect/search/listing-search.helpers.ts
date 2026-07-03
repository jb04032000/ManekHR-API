/**
 * Pure helpers for Connect marketplace listing search (M1.4). No Nest, no
 * Mongoose, so they unit-test without the decorator-metadata pipeline and are
 * shared by the Meili and Mongo backends in SearchService.
 *
 * Mirrors `people-search.helpers.ts` so the two verticals stay shape-symmetric
 * and the federation layer can fan out to both without per-vertical hacks.
 */

import { Types } from 'mongoose';
import type {
  ListingCourseFeeType,
  ListingCourseMode,
  ListingPriceType,
  ListingUnit,
} from '../marketplace/schemas/listing.schema';
import { romanizedIndexField } from './transliteration';

/**
 * Course-card slice of a `category === 'course'` listing (Institutes Phase 1).
 * Carried on the public listing card so a course card can show duration / mode /
 * fee instead of MOQ / unit. `null`/absent on every non-course listing. The fee
 * itself reuses the card's `priceMin` / `priceMax` (driven by `feeType`).
 */
export interface ListingCourseCard {
  durationLabel: string;
  batchStart: string | null;
  mode: ListingCourseMode;
  feeType: ListingCourseFeeType;
  seats: number | null;
  certificate: boolean;
  skillsTaught: string[];
}

/** Buyer-side filter knobs threaded through marketplace listing search. */
export interface ListingSearchFilters {
  /** Canonical category slug (any value -- the 8 known slugs or a custom term). */
  category?: string;
  /**
   * A SET of canonical category slugs -- the listing must be in ANY ONE of them
   * (OR semantics, unlike `tags` which AND). Powers a blended browse like the web
   * `/connect/services` page (show ALL service categories at once) without forcing
   * a single-category pick. Generic on the BE -- the caller passes whatever set it
   * wants; no category is special-cased here. Slugs are pre-trimmed + lowercased
   * by the DTO. PRECEDENCE: when BOTH `category` and a NON-EMPTY `categoryIn` are
   * present, `categoryIn` wins (the broader set intent supersedes the single pick);
   * an empty / absent `categoryIn` leaves the single `category` filter untouched.
   * Mirrors the single-`category` filter (Meili `category IN [...]` / Mongo
   * `category: { $in: [...] }`), the way `skills IN [...]` mirrors a single skill.
   */
  categoryIn?: string[];
  /** Seller district / textile hub; matched case-insensitively. */
  district?: string;
  /**
   * Inclusive lower bound on the listing's `priceMin` (asking-price floor).
   * Drops listings whose floor sits below the buyer's range start.
   */
  priceMin?: number;
  /**
   * Inclusive upper bound on the listing's `priceMin`. Drops listings whose
   * floor sits above the buyer's range end. (We filter on the floor so a
   * negotiable / open-range listing still surfaces; the buyer narrows by
   * eye when the floor is in range.)
   */
  priceMax?: number;
  /**
   * Restrict to a single seller's listings - the seam the "my listings" view
   * can reuse without a second query path.
   */
  ownerUserId?: string;
  /**
   * Restrict to a single storefront's listings - the additive facet powering a
   * shop's branded page / a buyer "shop only" narrow. Omit for the shared
   * cross-seller browse (unchanged default).
   */
  storefrontId?: string;
  /**
   * Canonical tag slugs to filter by. Each slug produces an AND-clause so
   * only listings carrying ALL requested tags surface. Mirrors the `category`
   * filter style: each value is a quoted Meili equality clause
   * (`tags = "kanjivaram"`).
   */
  tags?: string[];
  /**
   * Restrict to listings whose owner carries the verified trust marker (M2.3).
   * Only `true` narrows; `false` / `undefined` is the unfiltered default (a
   * "verified sellers only" toggle, never an "unverified only" one). On the
   * Meili path this is a `verified = true` filter clause; on the Mongo fallback
   * the marker is not a `Listing` field (it is a denormalized owner signal
   * resolved at hydration), so it filters the hydrated cards instead - see
   * {@link applyVerifiedRefFilter}.
   */
  verified?: boolean;
  /**
   * Result ordering (the marketplace sort dropdown). One of {@link LISTING_SORTS};
   * an absent / unknown value (and the deferred `top_rated`) collapses to
   * `recent`. Orders results, it does NOT narrow them - so it is intentionally
   * ignored by {@link hasListingFilters}.
   */
  sort?: string;
}

/**
 * The marketplace sort-dropdown contract (web sends these literal strings).
 *
 *   - `recent` (DEFAULT) - newest first (createdAt descending).
 *   - `price_low`        - cheapest first (ascending price floor).
 *   - `price_high`       - dearest first (descending price ceiling, then floor).
 *   - `verified_first`   - verified sellers first, then newest.
 *   - `top_rated`        - highest-rated first. DEFERRED: the seller rating is
 *     NOT denormalized onto the listing (it lives in the separate
 *     `connect_seller_ratings` collection, joined post-query in
 *     `FederatedSearchService.enrichListingRatings`), so it cannot be a single-
 *     query sort without a cross-collection join. {@link normalizeListingSort}
 *     folds it to `recent` until a rating field is denormalized onto the listing
 *     document + index (a separate logical change).
 */
export const LISTING_SORTS = [
  'recent',
  'price_low',
  'price_high',
  'verified_first',
  'top_rated',
] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];

/**
 * The sort keys that resolve to a REAL, single-query ordering today. `top_rated`
 * is deliberately absent (it needs a cross-collection rating join), so it folds
 * to `recent` in {@link normalizeListingSort}.
 */
const REAL_LISTING_SORTS: ReadonlySet<string> = new Set([
  'recent',
  'price_low',
  'price_high',
  'verified_first',
]);

/**
 * Normalize an incoming sort value to a real, supported sort key. An absent /
 * unknown value, and the deferred `top_rated`, both collapse to `recent` - the
 * stable default ordering (newest first) the marketplace shipped with.
 */
export function normalizeListingSort(sort?: string): ListingSort {
  return sort && REAL_LISTING_SORTS.has(sort) ? (sort as ListingSort) : 'recent';
}

/**
 * Translate a sort key into the per-backend sort spec. Pure + backend-agnostic:
 * the Meili leg consumes the `meili` array (an `attr:direction` list passed to
 * `/multi-search`), the Mongo fallback consumes the `mongo` object. The two are
 * kept logically equivalent so a buyer sees the same order on either backend.
 *
 *   - `recent`         -> newest first.
 *   - `price_low`      -> ascending price floor (`priceMin`). A negotiable /
 *     unpriced listing has `priceMin = null`, which Mongo and Meili both sort
 *     AFTER real numbers on an ascending sort, so open-price listings land last.
 *   - `price_high`     -> descending price ceiling (`priceMax`) then floor
 *     (`priceMin`), so a listing with only a floor still ranks by what it has.
 *   - `verified_first` -> a DB-level newest-first ordering, with the verified
 *     hoist applied on top (Meili via `verified:desc`; the Mongo fallback via
 *     {@link applyVerifiedFirstOrder} post-hydration, since `verified` is not a
 *     `Listing` column). The Mongo sort therefore carries only the
 *     `createdAt:-1` tiebreak.
 *   - `top_rated`      -> folded to `recent` (see {@link normalizeListingSort}).
 */
export function buildListingSort(sort?: string): {
  key: ListingSort;
  meili: string[];
  mongo: Record<string, 1 | -1>;
} {
  const key = normalizeListingSort(sort);
  switch (key) {
    case 'price_low':
      return { key, meili: ['priceMin:asc'], mongo: { priceMin: 1 } };
    case 'price_high':
      return {
        key,
        meili: ['priceMax:desc', 'priceMin:desc'],
        mongo: { priceMax: -1, priceMin: -1 },
      };
    case 'verified_first':
      return { key, meili: ['verified:desc', 'createdAt:desc'], mongo: { createdAt: -1 } };
    case 'recent':
    default:
      return { key, meili: ['createdAt:desc'], mongo: { createdAt: -1 } };
  }
}

/** Escape regex metacharacters in user input. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a value for a double-quoted Meilisearch filter literal. */
function quoteMeili(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * True when at least one NARROWING facet is set. `sort` is deliberately not
 * counted (it orders the result set, it does not narrow it - a sort-only request
 * with a blank query is still "nothing to search"). `verified` counts only when
 * `true`, since `false` is the unfiltered default.
 */
export function hasListingFilters(filters: ListingSearchFilters): boolean {
  return Boolean(
    filters.category ||
    (filters.categoryIn && filters.categoryIn.length > 0) ||
    (filters.district && filters.district.trim().length > 0) ||
    filters.priceMin !== undefined ||
    filters.priceMax !== undefined ||
    filters.ownerUserId ||
    filters.storefrontId ||
    (filters.tags && filters.tags.length > 0) ||
    filters.verified === true,
  );
}

/**
 * The indexed listing document. Only `active` + `approved` listings reach the
 * index (the search service purges anything else), so the public gate is
 * effectively baked in - the filter clauses still pin it for safety in case a
 * stale doc lingers between an admin reject and the next reindex sweep.
 */
export interface ConnectListingDocument {
  id: string;
  title: string;
  description: string;
  /** Canonical category slug (one of the 8 known slugs or a custom term). */
  category: string;
  priceType: ListingPriceType;
  priceMin: number | null;
  priceMax: number | null;
  unit: ListingUnit | null;
  district: string;
  ownerUserId: string;
  /** The storefront this product is filed under (additive M-seam). `null` for a
   *  legacy listing not yet backfilled into a shop. Filterable, not searchable. */
  storefrontId: string | null;
  images: string[];
  tags: string[];
  /** SRCH-I18N-1: Latin romanization of any Gujarati-script title/description/
   *  category/tag tokens, so a Latin query finds Gujarati-script listings.
   *  Lowest-rank searchable; `''` when all-Latin. Not displayed. */
  romanized: string;
  status: 'active';
  moderationStatus: 'approved';
  /**
   * Owner trust + paid-priority signals, denormalized from the seller's Connect
   * allowances at index time (M2.3). Same pattern as the people index's
   * `erpLinked`: a per-owner signal cached on the document, refreshed on the
   * next listing write or reindex. `verified` drives the badge; `searchPriority`
   * is a numeric ranking rule (`searchPriority:desc`) so paid sellers rank up.
   */
  verified: boolean;
  searchPriority: number;
  /** Unix ms so Meili's `createdAt:desc` ranking rule sorts numerically. */
  createdAt: number;
  /**
   * Demo Content scope: 0 for a real listing, 1 for a seeded sample one (read
   * from the listing's denormalized `isDemo`). Numeric so the `demoRank:asc`
   * ranking rule sinks demo below an otherwise-equal real tie. One source — the
   * web "Sample" badge + the demo-rank.ts down-rank both key off the same flag.
   */
  demoRank: number;
}

/**
 * The owner trust signals stamped onto a listing at index / hydration time.
 * Sourced from `ConnectAllowanceService.getAllowances(ownerUserId)` (M2.3).
 */
export interface ListingOwnerSignals {
  verified: boolean;
  searchPriority: number;
}

/** Minimal listing slice {@link buildListingDocument} needs. */
export interface ListingForIndex {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  storefrontId?: Types.ObjectId | string | null;
  title: string;
  description?: string;
  /** Canonical category slug (any value -- open string after the enum was dropped). */
  category: string;
  priceType: ListingPriceType;
  priceMin?: number | null;
  priceMax?: number | null;
  unit?: ListingUnit;
  location?: { district?: string };
  images?: string[];
  tags?: string[];
  createdAt?: Date;
  /** Denormalized seeded-sample marker (Demo Content scope), stamped at create
   *  from the owner's `User.isDemo`. Defaults to false on a legacy row. */
  isDemo?: boolean;
}

/**
 * Map a listing document to the indexed shape. District is lower-cased so the
 * `district = "surat"` filter matches regardless of how the seller typed it;
 * createdAt collapses to unix ms for the sort rule.
 */
export function buildListingDocument(
  listing: ListingForIndex,
  owner: ListingOwnerSignals = { verified: false, searchPriority: 0 },
): ConnectListingDocument {
  return {
    id: String(listing._id),
    title: listing.title.trim(),
    description: (listing.description ?? '').trim(),
    category: listing.category,
    priceType: listing.priceType,
    priceMin: listing.priceMin ?? null,
    priceMax: listing.priceMax ?? null,
    unit: listing.unit ?? null,
    district: (listing.location?.district ?? '').trim().toLowerCase(),
    ownerUserId: String(listing.ownerUserId),
    storefrontId: listing.storefrontId ? String(listing.storefrontId) : null,
    images: listing.images ?? [],
    tags: listing.tags ?? [],
    romanized: romanizedIndexField(
      listing.title,
      listing.description,
      listing.category,
      listing.tags,
    ),
    status: 'active',
    moderationStatus: 'approved',
    verified: owner.verified,
    searchPriority: owner.searchPriority,
    createdAt: (listing.createdAt ?? new Date()).getTime(),
    // 0 real / 1 demo so the `demoRank:asc` rule sinks seeded sample listings.
    demoRank: listing.isDemo ? 1 : 0,
  };
}

/**
 * Build the Meilisearch `filter` clauses (AND-ed) for marketplace listing
 * search. Always pins `status='active'` + `moderationStatus='approved'` on the
 * public path - a stale doc that somehow lingers will not surface.
 */
export function buildListingMeiliFilter(
  filters: ListingSearchFilters,
  opts: { publicOnly: boolean } = { publicOnly: true },
): string[] {
  const clauses: string[] = [];
  if (opts.publicOnly) {
    clauses.push("status = 'active'");
    clauses.push("moderationStatus = 'approved'");
  }
  // Category filter. A non-empty `categoryIn` set takes precedence over a single
  // `category` (the broader OR-set intent wins), so the two never both emit. The
  // set clause mirrors the people vertical's `skills IN [...]` (each value quoted,
  // comma-joined) -- `category` is a Meili filterableAttribute, so `IN [...]` is
  // valid and matches ANY of the listed slugs.
  if (filters.categoryIn && filters.categoryIn.length > 0) {
    const list = filters.categoryIn.map(quoteMeili).join(', ');
    clauses.push(`category IN [${list}]`);
  } else if (filters.category) {
    clauses.push(`category = ${quoteMeili(filters.category)}`);
  }
  if (filters.district && filters.district.trim().length > 0) {
    clauses.push(`district = ${quoteMeili(filters.district.trim().toLowerCase())}`);
  }
  if (filters.priceMin !== undefined) clauses.push(`priceMin >= ${filters.priceMin}`);
  if (filters.priceMax !== undefined) clauses.push(`priceMin <= ${filters.priceMax}`);
  if (filters.ownerUserId) clauses.push(`ownerUserId = ${quoteMeili(filters.ownerUserId)}`);
  if (filters.storefrontId) clauses.push(`storefrontId = ${quoteMeili(filters.storefrontId)}`);
  for (const tag of filters.tags ?? []) {
    clauses.push(`tags = ${quoteMeili(tag)}`);
  }
  // "Verified sellers only": only `true` narrows. `verified` is a boolean on the
  // indexed document (denormalized owner signal, M2.3) -- it must be listed in
  // the index `filterableAttributes` for this clause to take effect.
  if (filters.verified === true) clauses.push('verified = true');
  return clauses;
}

/**
 * Public marketplace card shape - the federation result row for a listing.
 * Mirrors the people-vertical `ConnectPersonRef` pattern: a slim, render-ready
 * projection that the listing card UI consumes directly. Hydrated from the
 * lean `Listing` document by {@link toListingRef}.
 *
 *   - `coverImage` is the first uploaded image, or `null` for a listing that
 *     has none. The marketplace card renders a category placeholder in that
 *     case.
 *   - `district` carries the original casing the seller typed (the indexed
 *     doc lower-cases for filtering; the card needs the human form).
 */
export interface ConnectListingRef {
  listingId: string;
  ownerUserId: string;
  title: string;
  description: string;
  /** Canonical category slug (open string -- may be one of the 8 known slugs or a custom term). */
  category: string;
  priceType: ListingPriceType;
  priceMin: number | null;
  priceMax: number | null;
  unit: ListingUnit | null;
  district: string;
  coverImage: string | null;
  /** All uploaded image URLs (cover first); drives the card's hover carousel. */
  images: string[];
  /**
   * True when the listing has a product video. Drives the small play badge on the
   * card cover (the cover image is NOT swapped for the poster - images stay the
   * cover). Derived from the listing's `videos` array; the video URLs themselves
   * are not sent to the card (the badge only needs the boolean).
   */
  hasVideo: boolean;
  /** Owner trust marker (M2.3) - drives the "Verified" badge on the card. */
  verified: boolean;
  /** Minimum order quantity (in `unit`s); `null` when the seller did not set one. */
  moq: number | null;
  /**
   * Course-card detail when `category === 'course'` (Institutes Phase 1); `null`
   * for every other listing. Lets a course card render duration / mode / fee in
   * place of MOQ / unit. Present on both the marketplace browse and storefront
   * read paths (it lives on the listing document, not a cross-collection join).
   */
  courseDetails: ListingCourseCard | null;
  /**
   * Shop Collection ids this product belongs to. Populated on the STOREFRONT
   * read path (so the public store can filter its grid by collection client-
   * side); empty on the global marketplace / search cards (those never display
   * a product's collections, and the Meili index does not carry the field).
   */
  collectionIds: string[];
  /**
   * Seller rating aggregate (marketplace Phase C, R2) - drives the star row on
   * the card. Present only when the owner is actually rated; `undefined` renders
   * no stars. Shape kept inline so the search layer stays decoupled from the
   * reviews module (structurally identical to `RatingAggregate`).
   */
  rating?: { ratingAvg: number; ratingCount: number };
  /**
   * True for a seeded demo / sample listing (denormalized `Listing.isDemo`).
   * Drives the web "Sample" disclosure badge on the marketplace + search cards;
   * one source of truth with the marketplace/search demo down-rank (demoRank).
   * Mirror of the owner `verified` marker. Keep in sync with the web
   * `ConnectListingRef` (search.types.ts) + `ListingGridCard`/`ListingCard`.
   */
  isDemo: boolean;
  createdAt: Date;
}

/** Minimal listing slice {@link toListingRef} needs (mirror of ListingForIndex). */
export interface ListingForRef {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  title: string;
  description?: string;
  /** Canonical category slug (open string -- may be one of the 8 known slugs or a custom term). */
  category: string;
  priceType: ListingPriceType;
  priceMin?: number | null;
  priceMax?: number | null;
  unit?: ListingUnit;
  moq?: number | null;
  location?: { district?: string };
  images?: string[];
  /** Course detail (course listings only); mapped onto the card's `courseDetails`. */
  courseDetails?: {
    durationLabel?: string;
    batchStart?: Date | string | null;
    mode?: ListingCourseMode;
    feeType?: ListingCourseFeeType;
    seats?: number | null;
    certificate?: boolean;
    skillsTaught?: string[];
  } | null;
  /** Product video(s) - only the presence (length) is read, to set `hasVideo`. */
  videos?: Array<{ url?: string }>;
  /** Shop Collection memberships (storefront read path only); absent elsewhere. */
  collectionIds?: (Types.ObjectId | string)[];
  /** Denormalized sample-content marker (Listing.isDemo); mapped onto the card's isDemo. */
  isDemo?: boolean;
  createdAt?: Date;
}

/**
 * Normalize a listing's stored `courseDetails` into the render-ready card slice.
 * Returns `null` for a non-course listing (no courseDetails) or one missing the
 * required core fields, so a card never renders a half-built course block.
 * `batchStart` collapses to an ISO string (or null) for transport.
 */
export function toCourseCard(course: ListingForRef['courseDetails']): ListingCourseCard | null {
  if (!course || !course.durationLabel || !course.mode || !course.feeType) return null;
  const batchStart = course.batchStart ? new Date(course.batchStart).toISOString() : null;
  return {
    durationLabel: course.durationLabel,
    batchStart,
    mode: course.mode,
    feeType: course.feeType,
    seats: course.seats ?? null,
    certificate: course.certificate ?? false,
    skillsTaught: course.skillsTaught ?? [],
  };
}

/**
 * Map a (lean) Listing into the federation card shape. Empty description and
 * missing image collapse to safe defaults so the card never renders
 * `undefined`. Casing on `district` is preserved (the buyer sees "Surat",
 * not "surat") even though the index stores it lower-cased.
 */
export function toListingRef(
  listing: ListingForRef,
  owner: { verified?: boolean; rating?: { ratingAvg: number; ratingCount: number } } = {},
): ConnectListingRef {
  return {
    listingId: String(listing._id),
    ownerUserId: String(listing.ownerUserId),
    title: listing.title,
    description: listing.description ?? '',
    category: listing.category,
    priceType: listing.priceType,
    priceMin: listing.priceMin ?? null,
    priceMax: listing.priceMax ?? null,
    unit: listing.unit ?? null,
    district: listing.location?.district ?? '',
    coverImage: listing.images?.[0] ?? null,
    images: listing.images ?? [],
    hasVideo: (listing.videos?.length ?? 0) > 0,
    verified: owner.verified ?? false,
    moq: listing.moq ?? null,
    courseDetails: toCourseCard(listing.courseDetails),
    collectionIds: (listing.collectionIds ?? []).map(String),
    ...(owner.rating && owner.rating.ratingCount > 0 ? { rating: owner.rating } : {}),
    // Denormalized sample-content marker -> drives the web "Sample" badge on the card.
    isDemo: listing.isDemo === true,
    createdAt: listing.createdAt ?? new Date(),
  };
}

/**
 * Apply the "verified sellers only" narrow to a page of hydrated cards. Needed
 * on the Mongo fallback (where `verified` is not a `Listing` column but a
 * per-owner signal resolved at hydration) and as a safety refinement on the
 * Meili path. A no-op unless `verified === true`; returns the SAME array
 * reference when it does nothing so callers can cheaply detect "unchanged".
 */
export function applyVerifiedRefFilter(
  refs: ConnectListingRef[],
  verified?: boolean,
): ConnectListingRef[] {
  if (verified !== true) return refs;
  return refs.filter((ref) => ref.verified);
}

/**
 * Hoist verified cards ahead of unverified ones for the `verified_first` sort,
 * preserving each group's existing (DB-ranked) relative order. Pure + stable.
 * A no-op (same array reference) for any other sort key - on the Meili path the
 * `verified:desc` sort rule already did this; this is the Mongo-fallback path's
 * equivalent (and a harmless re-assert on Meili). `verified` is a boolean on the
 * card, so the partition is a single pass.
 */
export function applyVerifiedFirstOrder(
  refs: ConnectListingRef[],
  sortKey: ListingSort,
): ConnectListingRef[] {
  if (sortKey !== 'verified_first') return refs;
  const verified: ConnectListingRef[] = [];
  const rest: ConnectListingRef[] = [];
  for (const ref of refs) (ref.verified ? verified : rest).push(ref);
  return [...verified, ...rest];
}

/**
 * Build the Mongo conditions for the listing-search fallback. Mirrors the
 * Meili filter so both backends return the same listings: category exact,
 * district case-insensitive, price floor range, owner exact.
 *
 * NOTE: `verified` is intentionally NOT a condition here - it is not a `Listing`
 * field but a denormalized per-owner signal resolved at hydration, so the
 * fallback applies it to the hydrated cards via {@link applyVerifiedRefFilter}.
 */
export function buildListingMongoConditions(
  filters: ListingSearchFilters,
  opts: { publicOnly: boolean } = { publicOnly: true },
): Record<string, unknown> {
  const conditions: Record<string, unknown> = {};
  if (opts.publicOnly) {
    conditions.status = 'active';
    conditions.moderationStatus = 'approved';
  }
  // Category filter, mirroring the Meili leg above: a non-empty `categoryIn` set
  // (Mongo `$in`, OR semantics -- distinct from the `tags` `$all` AND) takes
  // precedence over a single `category` equality; the two never both emit.
  if (filters.categoryIn && filters.categoryIn.length > 0) {
    conditions.category = { $in: filters.categoryIn };
  } else if (filters.category) {
    conditions.category = filters.category;
  }
  if (filters.district && filters.district.trim().length > 0) {
    conditions['location.district'] = new RegExp(`^${escapeRegex(filters.district.trim())}$`, 'i');
  }
  const priceClause: Record<string, number> = {};
  if (filters.priceMin !== undefined) priceClause.$gte = filters.priceMin;
  if (filters.priceMax !== undefined) priceClause.$lte = filters.priceMax;
  if (Object.keys(priceClause).length > 0) conditions.priceMin = priceClause;
  if (filters.ownerUserId) {
    conditions.ownerUserId = new Types.ObjectId(filters.ownerUserId);
  }
  if (filters.storefrontId) {
    conditions.storefrontId = new Types.ObjectId(filters.storefrontId);
  }
  if (filters.tags && filters.tags.length > 0) {
    // AND semantics: a listing must carry ALL requested tag slugs. Mirrors the
    // Meili path where each slug produces its own equality clause (all must match).
    conditions.tags = { $all: filters.tags };
  }
  return conditions;
}
