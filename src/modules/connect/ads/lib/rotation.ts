/**
 * Equal-bid rotation (fairness control C6).
 *
 * The auction sorts candidates descending by score. Picking `scored[0]` every
 * time means that when two advertisers bid the same, ONE of them always wins
 * and the other is starved. `pickTopWithRotation` instead gathers every
 * candidate whose score is within EQUAL_BID_EPSILON of the top score (an
 * "effective tie") and picks one of them at random, so equal bidders share the
 * inventory over repeated auctions.
 *
 * Used by ad-decision.service (the only caller) right after the descending
 * sort. Kept pure (no Redis, no clock) so it can be unit-tested deterministically
 * with a seeded rng; the service passes Math.random in production.
 *
 * Gotcha: `scored` MUST already be sorted descending by `.s` (the service does
 * this). The epsilon is an ABSOLUTE score delta, not a percentage.
 */

/**
 * Scores within this absolute delta of the top score are treated as a tie and
 * rotated. Sub-cent on the CPM-credits scale, so it captures identical bids and
 * floating-point-equal eCPMs without ever grouping genuinely different bids.
 */
export const EQUAL_BID_EPSILON = 0.001;

export interface Scored<T> {
  c: T;
  s: number;
}

/**
 * Pick the winner among the top-scored candidates, rotating among effective
 * ties. Returns the single top candidate when nothing else is within epsilon.
 *
 * @param scored  candidates sorted DESCENDING by score (`.s`); must be non-empty
 * @param rng     0..1 source (default Math.random); injected as a seeded fn in tests
 * @param epsilon absolute score delta that counts as a tie (default EQUAL_BID_EPSILON)
 */
export function pickTopWithRotation<T>(
  scored: Scored<T>[],
  rng: () => number = Math.random,
  epsilon: number = EQUAL_BID_EPSILON,
): T {
  const top = scored[0].s;
  // Walk the already-sorted list; everything within epsilon of the top is tied.
  let tieEnd = 1;
  while (tieEnd < scored.length && top - scored[tieEnd].s <= epsilon) tieEnd++;
  if (tieEnd === 1) return scored[0].c;
  // Uniform pick across the tie group. Math.min guards rng() === 1 (some PRNGs).
  const idx = Math.min(Math.floor(rng() * tieEnd), tieEnd - 1);
  return scored[idx].c;
}
