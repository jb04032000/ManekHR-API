/**
 * targeting-normalize.ts - shared normalisation for boost audience targeting so
 * the audience COUNT (ConnectAudienceCounter) and the delivery MATCH
 * (matchesTargeting) use identical, case-insensitive comparison.
 *
 * Why this exists: the two paths previously disagreed and matched almost nobody.
 * The counter did an exact case-sensitive `skills $in spec.sectors`; the delivery
 * matcher did a case-sensitive compare against a lowercased `skills[0]`; and the
 * web ships display-case values (e.g. "Weaving", "Surat"). So title-case never
 * equalled the lowercased profile data, and "any skill" (counter) disagreed with
 * "primary skill only" (delivery). This module is the single source of that
 * normalisation; mirrors the people-search pattern (search/people-search.helpers
 * normalizeSkillsForIndex): trim + lowercase.
 *
 * Links: consumed by lib/targeting.ts (delivery) + services/ad-profile.source.ts
 * (the audience counter query + the AdProfile build). Keep all three in step.
 */

/**
 * Canonical comparison form: lowercase + strip ALL non-alphanumerics, so a slug
 * ("job-work"), a display name ("Job Work") and free text ("jobwork") reduce to
 * the same token. This lets the new slug-based pickers match today's free-text
 * profile data (typed with spaces/case) without a data migration.
 */
export function normTargetingValue(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Normalise a list of values, dropping empties + duplicates. */
export function normTargetingList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const n = normTargetingValue(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Anchored, case-insensitive RegExps for a Mongo `$in` against a free-text field
 * (e.g. ConnectProfile.skills / district). Mirrors the people-search Mongo
 * fallback so the audience count matches what delivery will actually serve.
 */
export function targetingRegexes(values: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const tokens = v
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(escapeRegex);
    if (tokens.length === 0) continue;
    const key = tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new RegExp(`^${tokens.join('[^a-z0-9]*')}$`, 'i'));
  }
  return out;
}
