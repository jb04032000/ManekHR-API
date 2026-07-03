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
 * `TopicMatchSource` (Phase 7c) — personalised discovery: recent public posts
 * whose hashtags or author skills overlap the viewer's declared trades/skills
 * (so a Zari karigar discovers Zari/embroidery posts beyond their follows).
 * Reuses existing post fields (`hashtags`, `authorSkills`) — no schema change —
 * and the skills the orchestrator already passes on the context (no extra
 * profile read). Read-time, cap-bounded; never fanned out.
 */
@Injectable()
export class TopicMatchSource implements CandidateSource {
  readonly key = 'topic';

  constructor(@InjectModel(Post.name) private readonly postModel: Model<Post>) {}

  async fetch(ctx: CandidateContext): Promise<ScoredCandidate[]> {
    if (ctx.viewerSkills.length === 0) return [];
    const skillsLower = ctx.viewerSkills.map((s) => s.toLowerCase().trim()).filter(Boolean);
    if (skillsLower.length === 0) return [];

    const since = new Date(ctx.now - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const posts = await this.postModel
      .find({
        deletedAt: null,
        visibility: 'public',
        authorId: { $ne: ctx.viewerId },
        createdAt: { $gte: since },
        // `hashtags` are stored lower-cased; `authorSkills` keep their declared
        // casing, so match each against the matching form of the viewer skills.
        $or: [{ hashtags: { $in: skillsLower } }, { authorSkills: { $in: ctx.viewerSkills } }],
      })
      .sort({ createdAt: -1 })
      .limit(DISCOVERY_SCAN_LIMIT)
      // PERF: scan media-LIGHT — scoring never reads the heavy inline `media`
      // blob (300KB+/post). It is re-hydrated for only the rendered page in
      // feed.service.toPage. Keep in sync with the other discovery sources.
      .select('-media')
      .lean<FeedPost[]>()
      .exec();

    return posts
      .map((post) => ({
        post,
        sourceScore: this.score(post, ctx.now, skillsLower),
        origin: this.key,
        reason: 'topic',
      }))
      .sort((a, b) => b.sourceScore - a.sourceScore)
      .slice(0, ctx.limit);
  }

  /** Overlap-weighted, recency-boosted: more shared skills + fresher → higher. */
  private score(post: FeedPost, now: number, skillsLower: string[]): number {
    const postTerms = new Set([
      ...post.hashtags,
      ...post.authorSkills.map((s) => s.toLowerCase().trim()),
    ]);
    let overlap = 0;
    for (const skill of skillsLower) {
      if (postTerms.has(skill)) overlap += 1;
    }
    const ageHours = Math.max(1, (now - new Date(post.createdAt).getTime()) / 3_600_000);
    const recency = Math.exp(-ageHours / (TRENDING_WINDOW_DAYS * 24));
    return overlap * (1 + recency);
  }
}
