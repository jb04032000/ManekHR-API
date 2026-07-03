/**
 * Pure dampening math for reader feedback (Phase 7d — "show me less"). No I/O,
 * no Mongo — just the constants + the decayed-penalty function the feed read
 * uses to turn a viewer's stored "not interested" marks into per-post / per-
 * author For-You score multipliers. Kept pure so the ranking effect is unit-
 * testable in isolation (mirrors `gst/gstr2b/gstr2b-recon.ts` as a pure core).
 *
 * Links to:
 *   - `ranking/default-additive.strategy.ts` — multiplies these factors into a
 *     post's score (a down-rank, never an exclusion);
 *   - `feed.service.ts` — builds the per-id factor maps at fetch time and runs
 *     the author-derivation count;
 *   - `schemas/feed-negative-signal.schema.ts` — the stored marks these read.
 *
 * Gotcha: a factor is a MULTIPLIER in (0,1]. 1 = no effect. Excluding a post is
 * NOT this file's job — hide/mute/block do hard exclusion elsewhere; this only
 * ever lowers a score so a heavily-engaged post can still surface.
 */

/**
 * A single "not interested on this post" cuts that post's For-You score to this
 * fraction while the mark is fresh. Mild — a single tap should nudge, not bury.
 */
export const NOT_INTERESTED_POST_FACTOR = 0.5;

/**
 * A DERIVED "not interested in this author" (>= threshold post marks within the
 * window) cuts EVERY one of that author's posts to this fraction while fresh.
 * Stronger than a single-post mark, still never an exclusion (the viewer never
 * asked to mute them — they just keep skipping their posts).
 */
export const NOT_INTERESTED_AUTHOR_FACTOR = 0.3;

/**
 * Half-life (days) of a not-interested mark's weight. The penalty `(1 - factor)`
 * halves every half-life, so the multiplier rises back toward 1 (no effect) as
 * the mark ages — a months-old "not interested" barely matters, matching how a
 * reader's taste drifts. Constant + commented per the spec; tunable here.
 */
export const NOT_INTERESTED_HALF_LIFE_DAYS = 30;

/**
 * >= this many DISTINCT not-interested post marks on ONE author within the
 * window auto-derives an author-level dampen (spec A3). At the threshold exactly.
 */
export const NOT_INTERESTED_AUTHOR_THRESHOLD = 3;

/** Look-back window (days) for the author-derivation count (spec A3). */
export const NOT_INTERESTED_AUTHOR_WINDOW_DAYS = 90;

/** How long a mute lasts before it auto-expires (spec A1 — muted_author +30d). */
export const MUTE_DURATION_DAYS = 30;

/**
 * The decayed score multiplier for a not-interested mark of a given age.
 *
 * `base` is the fresh-mark factor (e.g. `NOT_INTERESTED_POST_FACTOR`); the
 * penalty `(1 - base)` halves every `halfLifeDays`, so the returned multiplier
 * rises from `base` at age 0 toward 1 as the mark ages. A non-positive age (a
 * just-placed or clock-skewed mark) clamps to the full fresh `base`.
 */
export function dampenFactor(
  ageDays: number,
  base: number,
  halfLifeDays: number = NOT_INTERESTED_HALF_LIFE_DAYS,
): number {
  if (ageDays <= 0) return base;
  const remainingPenalty = (1 - base) * Math.pow(0.5, ageDays / halfLifeDays);
  return 1 - remainingPenalty;
}

/**
 * The author-derivation rule (spec A3): does `distinctPostMarks` distinct
 * not-interested post marks on one author within the window cross the threshold
 * that auto-derives an author-level dampen? At-or-above the threshold derives.
 */
export function deriveAuthorDampen(distinctPostMarks: number): boolean {
  return distinctPostMarks >= NOT_INTERESTED_AUTHOR_THRESHOLD;
}
