import type { Types } from 'mongoose';
import type { FeedPost } from '../feed.service';
import type { RankingSignals } from '../../profile/connect-profile.service';
import type { FeedTab } from '../dto/feed.dto';

/** Per-request context handed to a ranking strategy. */
export interface RankingContext {
  /** `Date.now()` captured once per feed read (stable across the window). */
  now: number;
  tab: FeedTab;
  viewerId: Types.ObjectId;
}

/**
 * A swappable feed-ranking algorithm (Phase 7b). The current `For You`
 * heuristic is `DefaultAdditiveStrategy`; a future learned / topic ranker
 * implements this same contract and is selected via the
 * `CONNECT_FEED_RANKING_STRATEGY` env var — with NO change to `FeedService`.
 * `rank` may return a Promise so a remote / ML ranker fits the seam.
 *
 * Stored-score seam: a precompute ranker would write a nullable
 * `FeedEntry.score` and sort on it; switching is (a) add the field, (b) a
 * worker fills it, (c) flip the env — `getFeed` already calls `rank` on a
 * materialised candidate window, so the read path never changes.
 */
export interface FeedRankingStrategy {
  /** Stable id — matches the `CONNECT_FEED_RANKING_STRATEGY` value. */
  readonly key: string;
  rank(
    posts: FeedPost[],
    signals: RankingSignals,
    ctx: RankingContext,
  ): FeedPost[] | Promise<FeedPost[]>;
}

/** DI token for the active `FeedRankingStrategy`. */
export const FEED_RANKING_STRATEGY = Symbol('FEED_RANKING_STRATEGY');
