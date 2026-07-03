import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FEED_RANKING_STRATEGY, type FeedRankingStrategy } from './feed-ranking-strategy.interface';
import { DefaultAdditiveStrategy } from './default-additive.strategy';
import { ChronologicalStrategy } from './chronological.strategy';

/**
 * Registers both ranking strategies and binds the ACTIVE one to
 * `FEED_RANKING_STRATEGY` based on `connectFeed.rankingStrategy`
 * (`CONNECT_FEED_RANKING_STRATEGY`; default `default-additive`, so the live
 * behaviour is preserved). A future strategy is added here + selected by env —
 * `FeedService` never changes.
 */
export const feedRankingProviders: Provider[] = [
  DefaultAdditiveStrategy,
  ChronologicalStrategy,
  {
    provide: FEED_RANKING_STRATEGY,
    useFactory: (
      config: ConfigService,
      additive: DefaultAdditiveStrategy,
      chrono: ChronologicalStrategy,
    ): FeedRankingStrategy =>
      config.get<string>('connectFeed.rankingStrategy') === chrono.key ? chrono : additive,
    inject: [ConfigService, DefaultAdditiveStrategy, ChronologicalStrategy],
  },
];
