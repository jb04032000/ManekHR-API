import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post } from '../schemas/post.schema';
import { EngagementEdge } from '../schemas/engagement-edge.schema';
import { NetworkService } from '../../network/network.service';
import type { FeedPost } from '../feed.service';
import type {
  CandidateSource,
  CandidateContext,
  ScoredCandidate,
} from './candidate-source.interface';
import { TRENDING_WINDOW_DAYS, DISCOVERY_SCAN_LIMIT } from '../feed.constants';

/**
 * `NetworkOutSource` (Phase 7c) — 2nd-degree discovery: "posts the people you
 * follow engaged with" (the GraphJet pattern). Traverses the unified
 * `EngagementEdge` log (W-D1) by the viewer's followees, so it needs NO new
 * schema. A post engaged with by MORE of your network ranks higher. Read-time,
 * cap-bounded; never fanned out. Empty when the viewer follows no one (the
 * cold-start TrendingSource carries that case instead).
 */
@Injectable()
export class NetworkOutSource implements CandidateSource {
  readonly key = 'network_out';

  constructor(
    @InjectModel(EngagementEdge.name) private readonly edgeModel: Model<EngagementEdge>,
    @InjectModel(Post.name) private readonly postModel: Model<Post>,
    private readonly networkService: NetworkService,
  ) {}

  async fetch(ctx: CandidateContext): Promise<ScoredCandidate[]> {
    const follows = await this.networkService.listFollowing(ctx.viewerId);
    const followeeIds = follows.map((f) => f.followeeId);
    if (followeeIds.length === 0) return [];

    const since = new Date(ctx.now - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const edges = await this.edgeModel
      .find({
        actorId: { $in: followeeIds },
        authorId: { $ne: ctx.viewerId }, // never surface the viewer's own posts
        createdAt: { $gte: since },
      })
      .sort({ createdAt: -1 })
      .limit(DISCOVERY_SCAN_LIMIT)
      .lean<Array<{ postId: Types.ObjectId; createdAt: Date }>>()
      .exec();
    if (edges.length === 0) return [];

    // Aggregate per post — how many of the viewer's follows engaged + freshest edge.
    const agg = new Map<string, { count: number; latest: number }>();
    for (const edge of edges) {
      const id = String(edge.postId);
      const ts = new Date(edge.createdAt).getTime();
      const prev = agg.get(id);
      if (prev) {
        prev.count += 1;
        prev.latest = Math.max(prev.latest, ts);
      } else {
        agg.set(id, { count: 1, latest: ts });
      }
    }

    const posts = await this.postModel
      .find({
        _id: { $in: [...agg.keys()].map((id) => new Types.ObjectId(id)) },
        deletedAt: null,
        visibility: 'public',
      })
      // PERF: media-LIGHT scan (see topic-match.source) — media is re-hydrated
      // for only the rendered page in feed.service.toPage.
      .select('-media')
      .lean<FeedPost[]>()
      .exec();
    const postById = new Map(posts.map((p) => [String(p._id), p]));

    return [...agg.entries()]
      .map(([id, a]): ScoredCandidate | null => {
        const post = postById.get(id);
        if (!post) return null;
        const ageHours = Math.max(1, (ctx.now - a.latest) / 3_600_000);
        const recency = Math.exp(-ageHours / (TRENDING_WINDOW_DAYS * 24));
        // More distinct followees engaged (log-damped) + fresher edge → higher.
        return {
          post,
          sourceScore: Math.log1p(a.count) * (1 + recency),
          origin: this.key,
          reason: 'networkOut',
        };
      })
      .filter((c): c is ScoredCandidate => c !== null)
      .sort((x, y) => y.sourceScore - x.sourceScore)
      .slice(0, ctx.limit);
  }
}
