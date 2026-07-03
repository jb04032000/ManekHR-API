import { Injectable } from '@nestjs/common';
import type { FeedPost } from '../feed.service';
import type { FeedRankingStrategy } from './feed-ranking-strategy.interface';

/**
 * Pure reverse-chronological ranking — returns the candidate window unchanged
 * (the `FeedEntry` read already sorts `postedAt` descending). Selectable via
 * `CONNECT_FEED_RANKING_STRATEGY=chrono`, and the second concrete implementation
 * that proves the `FeedRankingStrategy` seam carries more than one algorithm.
 */
@Injectable()
export class ChronologicalStrategy implements FeedRankingStrategy {
  readonly key = 'chrono';

  rank(posts: FeedPost[]): FeedPost[] {
    return posts;
  }
}
