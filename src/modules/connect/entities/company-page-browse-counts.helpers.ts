/**
 * Pure assembly for the public Company Page directory cards' cross-collection
 * counts. `CompanyPageService.browse` emits the lightweight base item (single
 * query); the public controller then runs a handful of grouped aggregations over
 * OTHER modules' collections (followers, open jobs, storefront products, the
 * owner's seller rating) and folds the resulting maps onto each card here. Kept
 * Mongoose-free so it unit-tests without a DB.
 *
 * Two key rules live here (so they are covered by unit tests, not the service):
 *  - `productCount` defaults to 0 when a page has no active products.
 *  - `rating` is OMITTED entirely for an unrated owner (ratingCount === 0). An
 *    unrated company shows no stars, never a "0.0".
 *
 * The base item carries an INTERNAL `ownerUserId` (the rating is author-level,
 * keyed by the page owner). This helper strips it from the public shape so the
 * HTTP response exposes only the documented card fields plus the merged counts.
 */

/** The page owner's seller rating aggregate, as `ReviewService` reports it. */
export interface RatingValue {
  ratingAvg: number;
  ratingCount: number;
}

/**
 * The base directory item as `CompanyPageService.browse` emits it, before the
 * cross-collection merge. `ownerUserId` is internal-only (used to key the rating
 * lookup) and is stripped from the public output.
 */
export interface BrowseItemBase {
  id: string;
  /** INTERNAL: the page owner, used to key the author-level rating. Stripped. */
  ownerUserId: string;
  slug: string;
  name: string;
  logo: string;
  /** Page banner URL ('' when none). Optional on the base so existing callers /
   *  fixtures compile; the merge always emits a string. */
  banner?: string;
  about: string;
  /** Page kind (business | institute). Optional on the base so existing callers /
   *  fixtures compile; the merge defaults to 'business' (the legacy value). */
  kind?: string;
  location: { district: string; city: string; state: string };
  specialization: string[];
  erpLinked: boolean;
  /** Whether the page has an intro video (lightweight play-badge flag). Optional
   *  on the base so existing callers / fixtures compile; the merge defaults false. */
  hasVideo?: boolean;
}

/**
 * The set of page-owner ids that are seeded demo/sample accounts (User.isDemo).
 * The public controller resolves it once (`CompanyPageStatsService.demoOwners`)
 * and the merge stamps each card's `isDemo` from it (default NOT-demo). Drives
 * the FE "Sample" disclosure badge + keeps parity with the feed/search down-rank.
 */
export type DemoOwnerSet = Set<string>;

/** The public directory card after the cross-collection merge. */
export interface BrowseItemMerged {
  id: string;
  /** The page owner's public Connect user id - the directory card uses it to
   *  start a direct message with the owner (the same id used by profiles / DMs). */
  ownerUserId: string;
  slug: string;
  name: string;
  logo: string;
  /** Page banner URL, '' when none. */
  banner: string;
  about: string;
  /** Page kind (business | institute). 'business' for legacy / unset pages. */
  kind: string;
  location: { district: string; city: string; state: string };
  specialization: string[];
  erpLinked: boolean;
  /** Whether the page has an intro video (play-badge flag, derived in browse). */
  hasVideo: boolean;
  /** Members following the page (cross-collection). */
  followerCount: number;
  /** This page's open job posts (cross-collection). */
  openJobsCount: number;
  /** Active products across the page's storefronts (cross-collection). Default 0. */
  productCount: number;
  /** The owner's seller rating. Present ONLY when the owner has been rated. */
  rating?: RatingValue;
  /** Whether the page's owner is a seeded demo/sample account (User.isDemo).
   *  The card shows the muted "Sample" disclosure badge when true; the same
   *  signal feeds the shared feed/search down-rank (demo-rank.ts). */
  isDemo: boolean;
}

type CountMap = Map<string, number>;
type RatingMap = Map<string, RatingValue>;

/** Round a mean rating to one decimal place (the displayed precision). */
export function roundRatingAvg(avg: number): number {
  return Math.round(avg * 10) / 10;
}

/**
 * Fold the cross-collection maps onto each base item and produce the public
 * cards. `followers` / `openJobs` / `productCounts` are keyed by PAGE id;
 * `ratings` is keyed by OWNER id (author-level). Missing counts default to 0;
 * the rating is attached only when its owner aggregate has `ratingCount > 0`.
 * `demoOwners` is keyed by OWNER id; a card is `isDemo` when its owner is in it
 * (default false / real), so the FE can show the muted "Sample" badge.
 */
export function mergeBrowseCounts(
  items: BrowseItemBase[],
  followers: CountMap,
  openJobs: CountMap,
  productCounts: CountMap,
  ratings: RatingMap = new Map(),
  demoOwners: DemoOwnerSet = new Set(),
): BrowseItemMerged[] {
  return items.map((item) => {
    // Build the public card from the documented base fields ONLY (the internal
    // ownerUserId and any pre-defaulted count/rating fields on the input are
    // intentionally not carried over -- this helper is their single authority).
    const merged: BrowseItemMerged = {
      id: item.id,
      ownerUserId: item.ownerUserId,
      slug: item.slug,
      name: item.name,
      logo: item.logo,
      banner: item.banner ?? '',
      about: item.about,
      kind: item.kind ?? 'business',
      location: item.location,
      specialization: item.specialization,
      erpLinked: item.erpLinked,
      hasVideo: item.hasVideo ?? false,
      followerCount: followers.get(item.id) ?? 0,
      openJobsCount: openJobs.get(item.id) ?? 0,
      productCount: productCounts.get(item.id) ?? 0,
      // Keyed by owner id; absent owner => real content (default false).
      isDemo: demoOwners.has(item.ownerUserId),
    };
    const rating = ratings.get(item.ownerUserId);
    if (rating && rating.ratingCount > 0) {
      merged.rating = {
        ratingAvg: roundRatingAvg(rating.ratingAvg),
        ratingCount: rating.ratingCount,
      };
    }
    return merged;
  });
}
