import { env } from '../../../config/env';

/**
 * ManekHR Connect — shared demo/sample content down-rank helper.
 *
 * What it does: exposes a single flat score multiplier (`DEMO_RANK_PENALTY`)
 * and `applyDemoPenalty(score, isDemo)` so every Connect scorer (feed, search,
 * marketplace, jobs, suggestions) down-ranks seeded demo/sample content the
 * SAME way and reads the penalty from ONE place. A seeded demo item is one
 * whose denormalized `isDemo` flag is true (stamped at create from the author's
 * `User.isDemo`).
 *
 * How to use: call `applyDemoPenalty` as the LAST multiplier in each scorer,
 * exactly like `SEEN_RANK_PENALTY` in default-additive.strategy.ts — it is a
 * down-rank, not an exclusion, so a demo item can still surface when nothing
 * else fills the slot (better an example than an empty feed while the community
 * grows). The same `isDemo` flag also drives the FE "Sample" disclosure badge,
 * so the badge and the down-rank read one source of truth.
 *
 * Cross-module: pairs with `crewroster-web/components/connect/SampleBadge.tsx`
 * (the visible disclosure) and the denormalized `isDemo` field on each content
 * doc (Post/Listing/Job/Rfq/Quote/CompanyPage/Storefront).
 *
 * Watch: the penalty magnitude is env-tunable via `connectFeed.demoPenalty`
 * (CONNECT_FEED_DEMO_PENALTY, default ~0.35) — never hardcode it at a call
 * site. Keep this as the final multiplier so it down-weights without disturbing
 * the relative order produced by the additive terms above it.
 */

/**
 * Flat score multiplier for seeded demo/sample content. Read from the env
 * loader so it is tunable per environment without a code change.
 */
export const DEMO_RANK_PENALTY = env.connectFeed.demoPenalty;

/**
 * Apply the demo down-rank to a computed score. Returns the score unchanged for
 * real content; multiplies it by `DEMO_RANK_PENALTY` for demo/sample content.
 * Use as the LAST multiplier in a scorer (mirrors `SEEN_RANK_PENALTY`).
 */
export const applyDemoPenalty = (score: number, isDemo: boolean): number =>
  isDemo ? score * DEMO_RANK_PENALTY : score;
