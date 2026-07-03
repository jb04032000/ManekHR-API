import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post } from '../schemas/post.schema';
import { TrendingPost, type TrendingPostDocument } from '../schemas/trending-post.schema';
import type { FeedPost } from '../feed.service';
import type {
  CandidateSource,
  CandidateContext,
  ScoredCandidate,
} from './candidate-source.interface';
import { TRENDING_WINDOW_DAYS, DISCOVERY_SCAN_LIMIT } from '../feed.constants';
import { applyDemoPenalty } from '../../common/demo-rank';

/**
 * Progressive cold-start windows (days). The trending scan tries the tightest
 * window first; if it finds NOTHING (a fresh deployment or a quiet trade week),
 * it widens — 14d → 30d → all-time — so a zero-network user is never served a
 * blank For-You just because the recent window happened to be empty. `null` =
 * no lower bound (evergreen most-engaged public posts). Owner decision
 * 2026-06-02: widen rather than show nothing.
 */
const TRENDING_WINDOWS_DAYS: Array<number | null> = [TRENDING_WINDOW_DAYS, 30, null];

/**
 * `TrendingSource` (Phase 7c) — recent public posts ranked by engagement
 * velocity. Doubles as the recent-popular COLD-START fallback: a small recency
 * floor means even zero-engagement recent posts surface, so a brand-new user
 * (or a young network with little engagement) still gets a non-empty For-You.
 * When the recent window is empty it widens to an evergreen fallback so the feed
 * never collapses to blank. Read-time, cap-bounded; never fanned out.
 */
@Injectable()
export class TrendingSource implements CandidateSource {
  readonly key = 'trending';

  constructor(
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    @InjectModel(TrendingPost.name)
    private readonly trendingModel: Model<TrendingPostDocument>,
  ) {}

  async fetch(ctx: CandidateContext): Promise<ScoredCandidate[]> {
    // Prefer the MATERIALIZED trending set (B2) — a periodic job scores a broad
    // window so a viral post older than the newest slice still surfaces, and the
    // read is one indexed lookup, not a corpus scan. Fall back to a live scan
    // only when the set is empty (fresh deploy / before the first refresh) so
    // cold-start is never blocked.
    let posts = await this.fromMaterialized(ctx);
    if (posts.length === 0) {
      posts = await this.liveScan(ctx);
    }

    return posts
      .map((post) => ({
        post,
        sourceScore: this.score(post, ctx.now),
        origin: this.key,
        reason: 'trending',
      }))
      .sort((a, b) => b.sourceScore - a.sourceScore)
      .slice(0, ctx.limit);
  }

  /** Read the materialized trending set (score-ordered), hydrate to live posts,
   *  drop the viewer's own + non-public + since-deleted, preserving order. */
  private async fromMaterialized(ctx: CandidateContext): Promise<FeedPost[]> {
    const rows = await this.trendingModel
      .find()
      .sort({ score: -1 })
      .limit(DISCOVERY_SCAN_LIMIT)
      .select('postId')
      .lean<Array<{ postId: Types.ObjectId }>>()
      .exec();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.postId);
    const posts = await this.postModel
      .find({
        _id: { $in: ids },
        deletedAt: null,
        visibility: 'public',
        authorId: { $ne: ctx.viewerId },
      })
      // PERF: media-LIGHT scan (see topic-match.source) — media is re-hydrated
      // for only the rendered page in feed.service.toPage.
      .select('-media')
      .lean<FeedPost[]>()
      .exec();
    // Restore the materialized (score) order — `$in` does not preserve it.
    const rank = new Map(ids.map((id, i) => [String(id), i]));
    return posts.sort((a, b) => (rank.get(String(a._id)) ?? 0) - (rank.get(String(b._id)) ?? 0));
  }

  /** Live windowed scan — the cold-start fallback when the materialized set is
   *  empty (fresh deploy / before the first refresh). Widens 14d -> 30d -> all. */
  private async liveScan(ctx: CandidateContext): Promise<FeedPost[]> {
    let posts: FeedPost[] = [];
    for (const windowDays of TRENDING_WINDOWS_DAYS) {
      const match: Record<string, unknown> = {
        deletedAt: null,
        visibility: 'public',
        authorId: { $ne: ctx.viewerId },
      };
      if (windowDays !== null) {
        match.createdAt = { $gte: new Date(ctx.now - windowDays * 24 * 60 * 60 * 1000) };
      }
      posts = await this.postModel
        .find(match)
        .sort({ createdAt: -1 })
        .limit(DISCOVERY_SCAN_LIMIT)
        // PERF: media-LIGHT scan (see topic-match.source) — media re-hydrated
        // for only the rendered page in feed.service.toPage.
        .select('-media')
        .lean<FeedPost[]>()
        .exec();
      if (posts.length > 0) break;
    }
    return posts;
  }

  /**
   * Engagement velocity — log-damped engagement decayed by post age, with a
   * small recency floor (`+0.2`) so recent zero-engagement posts still surface
   * (cold-start), and an ERP-linked trust nudge.
   */
  private score(post: FeedPost, now: number): number {
    const ageHours = Math.max(1, (now - new Date(post.createdAt).getTime()) / 3_600_000);
    const recency = Math.exp(-ageHours / (TRENDING_WINDOW_DAYS * 24));
    const engagement = Math.log1p(post.reactionCount + 2 * post.commentCount);
    const score = (engagement + 0.2) * recency + (post.authorErpLinked ? 0.3 : 0);
    // Demo/sample down-rank — LAST multiplier (mirrors the feed ranker) so seeded
    // demo posts can't leak back into For-You via the trending/discovery path
    // while the community grows. Keyed on the denormalized Post.isDemo.
    return applyDemoPenalty(score, post.isDemo === true);
  }
}
