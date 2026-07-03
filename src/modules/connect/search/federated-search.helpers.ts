/**
 * Pure helpers for the federated query layer (S1.5 + M1.4.2). No Nest, no
 * Mongoose, so they unit-test in isolation. They carry the cross-vertical
 * concerns that are pure data transforms: per-vertical weighting, facet merge,
 * and the alias->slug text composition.
 */
import type { PeopleSearchFilters } from './people-search.helpers';
import type { ListingSearchFilters } from './listing-search.helpers';

/**
 * A live Connect search vertical. People (S1.2) + listings (M1.4) are live;
 * jobs (P5) joins by adding its slug here plus a registry index entry and a
 * weight below - never a one-off in the query path.
 */
export type ConnectVertical =
  | 'people'
  | 'posts'
  | 'listings'
  | 'jobs'
  // SRCH-VERT-1: storefronts (shops) + company / institute pages.
  | 'storefronts'
  | 'pages';

/**
 * Relative weight per vertical, used to order result groups in the federated
 * (`type=all`) view. Higher wins. People sits above listings because a
 * candidate match is a stronger signal of intent than a marketplace listing
 * for a free-text query (a buyer looking up "Surat zari karigar" wants the
 * person first; if they explicitly select the listings tab, the per-vertical
 * weighting does not apply - only the active vertical is queried).
 */
export const VERTICAL_WEIGHTS: Record<ConnectVertical, number> = {
  people: 100,
  posts: 90,
  listings: 80,
  jobs: 75,
  // SRCH-VERT-1: pages (a business / institute identity, a strong intent signal
  // when a member types a company name) sit just below jobs; storefronts (a shop,
  // closely tied to its listings) just below pages. Both rank under the
  // person-first verticals in the `type=all` blend, matching the D1 jump-to intent
  // (a name search wants the identity, then its shop / products).
  pages: 70,
  storefronts: 65,
};

/** De-duplicate while preserving first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Order result groups by descending vertical weight. Generic over the group
 * shape (only `type` is read) and non-mutating. An unweighted vertical is
 * treated as weight 0 and sorts last. The sort is stable, so same-weight
 * verticals keep their input order.
 */
export function orderGroupsByWeight<G extends { type: string }>(
  groups: G[],
  weights: Record<string, number>,
): G[] {
  return [...groups].sort((a, b) => (weights[b.type] ?? 0) - (weights[a.type] ?? 0));
}

/**
 * Merge the explicit facet params (from the query string) with the facets
 * inferred by query understanding. Skills union; district prefers the explicit
 * value; openToWork is OR-ed. Absent facets are omitted so an empty skills
 * array never leaks into a filter.
 */
export function mergePeopleFacets(
  explicit: PeopleSearchFilters,
  intent: PeopleSearchFilters,
): PeopleSearchFilters {
  const merged: PeopleSearchFilters = {};

  const skills = unique([...(explicit.skills ?? []), ...(intent.skills ?? [])]);
  if (skills.length > 0) merged.skills = skills;

  const district = explicit.district ?? intent.district;
  if (district && district.trim().length > 0) merged.district = district;

  if (explicit.openToWork || intent.openToWork) merged.openToWork = true;

  // "Providing services" provider filter -> OR-ed like openToWork.
  if (explicit.providingServices || intent.providingServices) merged.providingServices = true;

  return merged;
}

/**
 * Lift the listings-vertical facets out of the federated search input. Pure
 * pass-through today (the DTO already validated each field); the function
 * exists so the federation has a single seam to extend with intent-merging
 * when query understanding learns to infer listing facets (e.g. a "saree
 * under 5000" phrase folding to `category=finished-goods` + `priceMax=5000`).
 *
 * Drops empty / undefined fields so the downstream `hasListingFilters` check
 * sees a clean shape.
 */
export function mergeListingFacets(explicit: ListingSearchFilters): ListingSearchFilters {
  const merged: ListingSearchFilters = {};
  if (explicit.category) merged.category = explicit.category;
  // Carry the multi-category set through only when non-empty (clean-shape
  // contract). The filter builders give it precedence over a single `category`.
  if (explicit.categoryIn && explicit.categoryIn.length > 0) {
    merged.categoryIn = explicit.categoryIn;
  }
  if (explicit.district && explicit.district.trim().length > 0) {
    merged.district = explicit.district;
  }
  if (explicit.priceMin !== undefined) merged.priceMin = explicit.priceMin;
  if (explicit.priceMax !== undefined) merged.priceMax = explicit.priceMax;
  if (explicit.ownerUserId) merged.ownerUserId = explicit.ownerUserId;
  if (explicit.tags && explicit.tags.length > 0) merged.tags = explicit.tags;
  // Only `true` narrows the result set (a "verified sellers only" toggle).
  if (explicit.verified === true) merged.verified = true;
  // Carry the sort through unchanged; the service normalizes unknown / deferred
  // values to `recent`. Drop an absent sort so the clean-shape contract holds.
  if (explicit.sort) merged.sort = explicit.sort;
  return merged;
}

/**
 * Fold canonical tag slugs into the search text for extra recall: a `#zardozi`
 * query (text "zardozi") whose canonical slug is "zari" searches "zardozi zari"
 * so it matches the canonical content too (which then synonym-expands). Purely
 * additive — slugs already present are not repeated, everything is lowercased.
 */
export function composeSearchText(text: string, extraTerms: string[]): string {
  const base = text.split(/\s+/).filter(Boolean);
  const extras = extraTerms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  return unique([...base, ...extras]).join(' ');
}
