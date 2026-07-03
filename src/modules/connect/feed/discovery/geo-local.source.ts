import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Post } from '../schemas/post.schema';
import type { FeedPost } from '../feed.service';
import type {
  CandidateSource,
  CandidateContext,
  ScoredCandidate,
} from './candidate-source.interface';
import { TRENDING_WINDOW_DAYS, DISCOVERY_SCAN_LIMIT } from '../feed.constants';

/**
 * `GeoLocalSource` (Phase 7c) — recent public posts from the viewer's own
 * district / textile hub (Surat, Jetpur…). High-signal in a trade network:
 * local supply, local hiring, local deals. Matches the denormalized
 * `Post.authorDistrict` (exact, trimmed — index-friendly) against the viewer's
 * district. Empty when the viewer has no district set. Read-time, cap-bounded;
 * never fanned out. (Case sensitivity is exact for v1; a canonical district
 * picker would make it case-insensitive without a regex scan.)
 */
@Injectable()
export class GeoLocalSource implements CandidateSource {
  readonly key = 'geo';

  constructor(@InjectModel(Post.name) private readonly postModel: Model<Post>) {}

  async fetch(ctx: CandidateContext): Promise<ScoredCandidate[]> {
    const district = (ctx.viewerDistrict ?? '').trim();
    if (!district) return [];

    const since = new Date(ctx.now - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const posts = await this.postModel
      .find({
        deletedAt: null,
        visibility: 'public',
        authorId: { $ne: ctx.viewerId },
        createdAt: { $gte: since },
        authorDistrict: district,
      })
      .sort({ createdAt: -1 })
      .limit(DISCOVERY_SCAN_LIMIT)
      // PERF: media-LIGHT scan (see topic-match.source) — media is re-hydrated
      // for only the rendered page in feed.service.toPage.
      .select('-media')
      .lean<FeedPost[]>()
      .exec();

    return posts
      .map((post) => ({
        post,
        sourceScore: this.score(post, ctx.now),
        origin: this.key,
        reason: 'geoLocal',
      }))
      .sort((a, b) => b.sourceScore - a.sourceScore)
      .slice(0, ctx.limit);
  }

  /** Locality is already a strong signal → recency-led, engagement-boosted. */
  private score(post: FeedPost, now: number): number {
    const ageHours = Math.max(1, (now - new Date(post.createdAt).getTime()) / 3_600_000);
    const recency = Math.exp(-ageHours / (TRENDING_WINDOW_DAYS * 24));
    const engagement = Math.log1p(post.reactionCount + 2 * post.commentCount);
    return (engagement + 0.5) * recency;
  }
}
