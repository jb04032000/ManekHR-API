/**
 * india-districts.ts — canonical India district lookups for boost region
 * targeting (recognition + backfill).
 *
 * What it does:
 *   Derives flat, normalized lookups from the shared `INDIA_GEO` dataset so the
 *   targeting matcher / audience counter can answer "is this viewer's free-text
 *   district a RECOGNIZED canonical district?" and so the backfill migration can
 *   canonicalize a recognizable free-text district to its canonical NAME + slugs.
 *
 * Cross-module links:
 *   - Source of truth is `modules/connect/geo/india-geo.ts` (the backend mirror
 *     of the web `features/connect/geo/india-geo.ts`, both built by
 *     scripts/india-geo/build-india-geo.mjs). KEEP IN SYNC with
 *     web `features/connect/geo/india-geo.ts` — this module re-derives from the
 *     backend copy, so refreshing india-geo automatically refreshes these.
 *   - Normalization MUST match `lib/targeting-normalize.ts` `normTargetingValue`
 *     (lowercase + strip non-alphanumerics) so a viewer district, a target
 *     district, and the canonical token all reduce to the same comparison form.
 *   - Consumed by `lib/targeting.ts` (matchesTargeting district rule + the
 *     unknown-location down-rank hook), `services/ad-profile.source.ts` (the
 *     audience counter + the geoDistrictSlug -> canonical NAME resolution), and
 *     the `0045_connect_backfill_profile_district_canonical` migration.
 *
 * Gotcha:
 *   The ~2018 india-geo snapshot has a handful of district-name COLLISIONS
 *   across states (e.g. "Bilaspur" in both Chhattisgarh + Himachal Pradesh,
 *   "Aurangabad" in Bihar + Maharashtra, "Hamirpur"/"Pratapgarh"/"Balrampur" in
 *   UP + another state). For RECOGNITION that is irrelevant (the token is
 *   recognized regardless of state). For BACKFILL it matters: a free-text
 *   district that maps to MORE THAN ONE canonical state is ambiguous, so the
 *   migration must NOT guess a state — `lookupCanonicalDistrict` returns the
 *   district NAME + slug but leaves the state ambiguous flag set so the caller
 *   can skip setting `geoStateSlug` (still sets the unambiguous district name +
 *   slug). Districts unique across India resolve their state too.
 */

import { INDIA_GEO } from '../../geo/india-geo';

/**
 * Canonical comparison form. Intentionally a LOCAL copy of
 * `normTargetingValue` (lowercase + strip non-alphanumerics) so this geo module
 * has no dependency on the ads `lib/` (avoids an import cycle: targeting.ts
 * imports this module). Keep the two byte-identical.
 */
function normDistrict(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface CanonicalDistrict {
  /** Canonical district display NAME, e.g. "East Godavari". */
  readonly name: string;
  /** Canonical district slug, e.g. "east-godavari". */
  readonly districtSlug: string;
  /**
   * Canonical state slug when the district name is unique across India; `null`
   * when the SAME district name exists in more than one state (ambiguous — the
   * backfill must not guess the state).
   */
  readonly stateSlug: string | null;
}

// Build the lookup once at module load. Key = normalized district NAME token.
const byNameToken = new Map<string, CanonicalDistrict>();
// Track name-token -> set of state slugs to detect cross-state collisions.
const stateSlugsByNameToken = new Map<string, Set<string>>();
// slug token (normalized district slug) -> canonical entry, for geoDistrictSlug.
const bySlugToken = new Map<string, CanonicalDistrict>();

for (const state of INDIA_GEO) {
  for (const d of state.districts) {
    const nameToken = normDistrict(d.name);
    const slugToken = normDistrict(d.slug);

    const states = stateSlugsByNameToken.get(nameToken) ?? new Set<string>();
    states.add(state.slug);
    stateSlugsByNameToken.set(nameToken, states);

    // First write wins for the name->entry map; the stateSlug is finalized below
    // once all collisions are known. Slug tokens are globally unique within a
    // state but can repeat across states (e.g. "bilaspur"), so the slug map also
    // resolves to a single entry; ambiguity is reflected via stateSlug=null.
    if (!byNameToken.has(nameToken)) {
      byNameToken.set(nameToken, {
        name: d.name,
        districtSlug: d.slug,
        stateSlug: state.slug,
      });
    }
    if (!bySlugToken.has(slugToken)) {
      bySlugToken.set(slugToken, {
        name: d.name,
        districtSlug: d.slug,
        stateSlug: state.slug,
      });
    }
  }
}

// Finalize: any name token seen in >1 state is ambiguous -> stateSlug null.
for (const [nameToken, states] of stateSlugsByNameToken) {
  if (states.size > 1) {
    const entry = byNameToken.get(nameToken);
    if (entry) byNameToken.set(nameToken, { ...entry, stateSlug: null });
    const slugEntry = bySlugToken.get(nameToken);
    if (slugEntry) bySlugToken.set(nameToken, { ...slugEntry, stateSlug: null });
  }
}

/**
 * Set of normalized canonical district NAME tokens — the recognition set used by
 * the matcher / counter to decide whether a viewer's free-text district is a
 * RECOGNIZED canonical district. Frozen so callers cannot mutate it.
 */
export const CANONICAL_DISTRICT_TOKENS: ReadonlySet<string> = new Set(byNameToken.keys());

/**
 * All canonical district display NAMES (deduped by normalized token). Consumed by
 * the audience counter (`ad-profile.source.ts`) to build the SAME recognition
 * regexes the matcher uses (via `targetingRegexes`), so the Mongo estimate query
 * mirrors `matchesTargeting`'s fallback (exclude only a recognized district NOT
 * in the target list; keep blank/unrecognized). Order is stable (INDIA_GEO order,
 * first occurrence of each name token).
 */
export const CANONICAL_DISTRICT_NAMES: readonly string[] = Array.from(byNameToken.values()).map(
  (d) => d.name,
);

/**
 * Is this free-text/slug value a recognized canonical India district?
 * Normalizes both the canonical names and the input the same way, so "East
 * Godavari", "east-godavari" and "eastgodavari" all recognize. Empty -> false.
 */
export function isRecognizedDistrict(value: string | null | undefined): boolean {
  if (!value) return false;
  return CANONICAL_DISTRICT_TOKENS.has(normDistrict(value));
}

/**
 * Resolve a free-text district to its canonical entry (NAME + slug + maybe
 * state). Returns `null` when the value is empty or not a recognized canonical
 * district. Never throws. Used by the backfill migration.
 */
export function lookupCanonicalDistrict(
  value: string | null | undefined,
): CanonicalDistrict | null {
  if (!value) return null;
  return byNameToken.get(normDistrict(value)) ?? null;
}

/**
 * Resolve a canonical district SLUG (e.g. "east-godavari" from the profile's
 * `geoDistrictSlug`) to its canonical NAME (+ state). Returns `null` for empty /
 * unrecognized slugs. Used by `ad-profile.source.ts` to prefer the structured
 * slug when present. Never throws.
 */
export function lookupCanonicalDistrictBySlug(
  slug: string | null | undefined,
): CanonicalDistrict | null {
  if (!slug) return null;
  return bySlugToken.get(normDistrict(slug)) ?? null;
}
