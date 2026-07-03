import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import { Post } from '../schemas/post.schema';
import { TrendingPost, type TrendingPostDocument } from '../schemas/trending-post.schema';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { minuteBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';
import {
  TRENDING_REFRESH_CRON,
  TRENDING_MATERIALIZE_WINDOW_DAYS,
  TRENDING_MATERIALIZE_SCAN_LIMIT,
  TRENDING_MATERIALIZE_TOP_N,
  TRENDING_GRAVITY,
} from '../feed.constants';
import { applyDemoPenalty } from '../../common/demo-rank';

/** The minimal post shape the refresh job scores. */
interface ScorablePost {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  reactionCount?: number;
  commentCount?: number;
  repostCount?: number;
  authorErpLinked?: boolean;
  /** Denormalized author demo/sample flag — drives the demo down-rank so seeded
   *  demo posts don't get materialized into the trending set. */
  isDemo?: boolean;
  createdAt: Date;
}

/**
 * ManekHR Connect — trending refresh job (feed hardening B2).
 *
 * Periodically (cron) recomputes a small materialized "trending" set with a
 * Hacker-News-style gravity score so the feed never scans the post corpus per
 * request, and a genuinely viral post that has aged past the newest slice still
 * surfaces. Replaces the whole set each run (the table is tiny). The feed's
 * `TrendingSource` reads this set and falls back to a live scan only when it is
 * empty (fresh deploy / before the first run), so cold-start is never blocked.
 */
@Injectable()
export class TrendingRefreshService {
  private readonly logger = new Logger(TrendingRefreshService.name);

  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(TrendingPost.name) private readonly trendingModel: Model<TrendingPostDocument>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Connect trending refresh
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per occurrence. See docs/architecture/scheduler-contract.md.
   * Schedule:    every 15 minutes (UTC) - recompute the materialized trending set
   *              so a viral post past the newest slice still surfaces.
   * Idempotent:  YES - convergent bulk upsert keyed on postId (unique index),
   *              then prune rows not stamped by this run. No delete-then-insert
   *              window, so a re-run or retry cannot collide on postId_1 (the
   *              original E11000) and produces the same end state.
   * Reads:       connect_posts
   * Writes:      connect_trending (materialized set only; no external side effects)
   * Missed run:  Self-heals - the next run fully rebuilds the set; the read path
   *              (TrendingSource) falls back to a live scan if the set is empty.
   * Owner:       connect/feed
   */
  @Cron(TRENDING_REFRESH_CRON, { name: 'connect-trending-refresh' })
  async refresh(): Promise<void> {
    try {
      await this.singleFlight.runExclusive(
        CronJobKey.CONNECT_TRENDING_REFRESH,
        minuteBucket(),
        () => this.rebuild(),
      );
    } catch (err) {
      this.logger.error(`Trending refresh failed: ${(err as Error)?.message}`);
      Sentry.captureException(err, { tags: { module: 'connect-feed', op: 'trending-refresh' } });
    }
  }

  /**
   * Convergent rebuild of the trending set. Public so tests can invoke it
   * directly without the cron/lock wrapper.
   */
  async rebuild(): Promise<void> {
    const now = Date.now();
    const runStamp = new Date(now);
    const since = new Date(now - TRENDING_MATERIALIZE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const posts = await this.postModel
      .find({ deletedAt: null, visibility: 'public', createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(TRENDING_MATERIALIZE_SCAN_LIMIT)
      .select(
        '_id authorId reactionCount commentCount repostCount authorErpLinked isDemo createdAt',
      )
      .lean<ScorablePost[]>()
      .exec();

    const top = posts
      .map((p) => ({
        postId: p._id,
        authorId: p.authorId,
        score: this.score(p, now),
        computedAt: runStamp,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TRENDING_MATERIALIZE_TOP_N);

    // Convergent upsert keyed on postId, then prune rows this run did not touch.
    // Replaces the old deleteMany-then-insertMany, which left a brief empty window
    // and could collide on the postId_1 unique index when two runs overlapped.
    if (top.length > 0) {
      const ops: AnyBulkWriteOperation<TrendingPost>[] = top.map((row) => ({
        updateOne: {
          filter: { postId: row.postId },
          update: {
            $set: { authorId: row.authorId, score: row.score, computedAt: row.computedAt },
          },
          upsert: true,
        },
      }));
      await this.trendingModel.bulkWrite(ops, { ordered: false });
    }
    // Drop rows older than this run (posts that fell out of the top set).
    await this.trendingModel.deleteMany({ computedAt: { $lt: runStamp } });

    this.logger.log(`Trending refreshed: ${top.length} post(s) from ${posts.length} scanned.`);
  }

  /**
   * Hacker-News gravity: `(points + 1) / (ageHours + 2)^1.8`, with a small
   * ERP-linked trust multiplier. The `+1` floor lets a fresh zero-engagement
   * post still earn a recency-driven score (cold-start). Reposts count most,
   * then comments, then reactions.
   */
  private score(p: ScorablePost, now: number): number {
    const points = (p.reactionCount ?? 0) + 2 * (p.commentCount ?? 0) + 3 * (p.repostCount ?? 0);
    const ageHours = Math.max(0, (now - new Date(p.createdAt).getTime()) / 3_600_000);
    const gravity = (points + 1) / Math.pow(ageHours + 2, TRENDING_GRAVITY);
    const score = gravity * (p.authorErpLinked ? 1.2 : 1);
    // Demo/sample down-rank — LAST multiplier so seeded demo posts are pushed to
    // the bottom of (and effectively out of) the materialized trending set,
    // closing the discovery leak-back path. Keyed on the denormalized Post.isDemo.
    return applyDemoPenalty(score, p.isDemo === true);
  }
}
