import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type PipelineStage } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import * as Sentry from '@sentry/nestjs';
import { ConnectTag } from './schemas/connect-tag.schema';
import { Post } from '../feed/schemas/post.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { hourBucket } from '../../../common/scheduler/period-key';
import { CronJobKey } from '../../../common/constants/cron.constants';

/** Recent window whose tag velocity is measured. */
const CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Trailing window used as the time-bounded baseline (the period before the current window). */
const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Distinct authors a tag needs in the current window to trend (volume + per-author rate cap). */
const MIN_DISTINCT_AUTHORS = 3;
/** Posts from accounts younger than this are excluded (new-account spam guard). */
const ACCOUNT_AGE_CUTOFF_MS = 2 * 24 * 60 * 60 * 1000;

interface TagAuthorCount {
  slug: string;
  authorCount: number;
}

/**
 * `TrendingTagsService` — velocity-over-baseline trending (S1.4).
 *
 * Trending is a SPIKE over a tag's own recent baseline, not raw popularity: a
 * perennially-busy tag at its steady rate does not trend; a tag rising fast
 * does. Spam-resistant by construction:
 *   - distinct AUTHORS (not raw mentions) cap each account's influence at one,
 *   - a min-distinct-authors gate kills single or tiny-group farming,
 *   - posts from brand-new accounts are excluded.
 * Mongo aggregation only (no Kafka / Redis), recomputed on a cron, written to
 * `ConnectTag.trendingScore`, and read by `GET /connect/tags/trending`.
 */
@Injectable()
export class TrendingTagsService {
  private readonly logger = new Logger(TrendingTagsService.name);
  private readonly tracer = trace.getTracer('connect.tags');

  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(ConnectTag.name) private readonly tagModel: Model<ConnectTag>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Connect trending tags recompute
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per hour. See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (UTC) - recompute every tag's velocity-over-baseline score.
   * Idempotent:  YES - convergent recompute: zeroes last cycle's trendingScore
   *              (updateMany) then bulkWrites the fresh spikes (updateOne upserts
   *              keyed on slug). No insert-append, so a re-run/retry produces the
   *              same end state. Tier B (double-run only wastes work).
   * Reads:       connect_posts, users
   * Writes:      connect_tags.trendingScore (materialized field only; no side effects)
   * Missed run:  Self-heals - the next hourly run fully recomputes from the live
   *              windows; a skipped hour just delays the refresh, never corrupts it.
   * Owner:       connect/tags
   */
  @Cron(CronExpression.EVERY_HOUR, { name: CronJobKey.CONNECT_TRENDING_TAGS })
  async handleTrendingCron(): Promise<void> {
    try {
      await this.singleFlight.runExclusive(CronJobKey.CONNECT_TRENDING_TAGS, hourBucket(), () =>
        this.process(),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Trending tags cron failed: ${detail}`);
      Sentry.captureException(err, { tags: { module: 'connect.tags', op: 'trendingCron' } });
    }
  }

  /** Recompute + log body, extracted so the single-flight wrapper stays thin. */
  private async process(): Promise<void> {
    const result = await this.recomputeTrending();
    this.logger.log(
      `Trending tags recomputed: ${result.trending}/${result.evaluated} (trending/evaluated).`,
    );
  }

  /**
   * Recompute every tag's `trendingScore` from the current window vs its
   * baseline. Clears last cycle's scores, then writes the fresh spikes.
   */
  async recomputeTrending(
    now: Date = new Date(),
  ): Promise<{ evaluated: number; trending: number }> {
    return this.withSpan('connect.tags.recomputeTrending', async (span) => {
      const currentStart = new Date(now.getTime() - CURRENT_WINDOW_MS);
      const baselineStart = new Date(now.getTime() - CURRENT_WINDOW_MS - BASELINE_WINDOW_MS);
      const accountAgeCutoff = new Date(now.getTime() - ACCOUNT_AGE_CUTOFF_MS);

      const [current, baseline] = await Promise.all([
        this.aggregateAuthorsByTag(currentStart, now, accountAgeCutoff),
        this.aggregateAuthorsByTag(baselineStart, currentStart, accountAgeCutoff),
      ]);

      const baselineBySlug = new Map(baseline.map((row) => [row.slug, row.authorCount]));
      const windowRatio = CURRENT_WINDOW_MS / BASELINE_WINDOW_MS;

      const ops: Array<{
        updateOne: { filter: { slug: string }; update: { $set: { trendingScore: number } } };
      }> = [];
      for (const row of current) {
        if (row.authorCount < MIN_DISTINCT_AUTHORS) continue;
        // Expected current-window authors, scaled from the trailing baseline.
        const expected = (baselineBySlug.get(row.slug) ?? 0) * windowRatio;
        // A Poisson-style spike score: 0 at the steady rate, high when rising.
        const score = Math.max(0, (row.authorCount - expected) / Math.sqrt(expected + 1));
        if (score <= 0) continue;
        ops.push({
          updateOne: {
            filter: { slug: row.slug },
            update: { $set: { trendingScore: Math.round(score * 1000) / 1000 } },
          },
        });
      }

      await this.tagModel.updateMany({ trendingScore: { $gt: 0 } }, { $set: { trendingScore: 0 } });
      if (ops.length > 0) await this.tagModel.bulkWrite(ops);

      span.setAttributes({ evaluated: current.length, trending: ops.length });
      return { evaluated: current.length, trending: ops.length };
    });
  }

  /**
   * Distinct authors per tag for public posts in `[start, end)`, excluding posts
   * from accounts created after `accountAgeCutoff`. Distinct authors (not raw
   * mentions) cap each account's influence at one.
   */
  private async aggregateAuthorsByTag(
    start: Date,
    end: Date,
    accountAgeCutoff: Date,
  ): Promise<TagAuthorCount[]> {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          visibility: 'public',
          createdAt: { $gte: start, $lt: end },
          hashtags: { $exists: true, $ne: [] },
        },
      },
      { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'author' } },
      { $unwind: '$author' },
      { $match: { 'author.createdAt': { $lte: accountAgeCutoff } } },
      { $unwind: '$hashtags' },
      { $group: { _id: '$hashtags', authors: { $addToSet: '$authorId' } } },
      { $project: { _id: 0, slug: '$_id', authorCount: { $size: '$authors' } } },
    ];
    return this.postModel.aggregate<TagAuthorCount>(pipeline);
  }

  private async withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
