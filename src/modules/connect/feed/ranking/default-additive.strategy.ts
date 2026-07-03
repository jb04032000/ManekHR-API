import { Injectable } from '@nestjs/common';
import type { FeedPost } from '../feed.service';
import type { RankingSignals } from '../../profile/connect-profile.service';
import type { FeedRankingStrategy, RankingContext } from './feed-ranking-strategy.interface';
import { applyDemoPenalty } from '../../common/demo-rank';

/**
 * Read-time `For You` ranking weights — a transparent additive score, no ML
 * (`phase-3-feed.md` B3). Tunable in one place; a future learned ranker is a
 * different `FeedRankingStrategy`, not an edit here.
 */
const RANK = {
  /** Freshness — full points for a brand-new post, exp-decaying over ~24h. */
  recency: 5,
  /** The moat — an ERP-linked author is the strongest single lift. */
  erpLinked: 8,
  /** Engagement — log-damped so one viral post cannot dominate the feed. */
  engagement: 2,
  /** Per shared skill between the viewer and the post author. */
  skillOverlap: 3,
  /** Cap on counted skill overlap. */
  maxSkillOverlap: 3,
  /** Persona match — the viewer's intent against the post's tags. */
  personaTag: 5,
  /** Directional affinity — lifts authors the viewer keeps engaging with. */
  affinity: 4,
  /** Cap on the counted affinity weight per author (one strong tie can't dominate). */
  maxAffinity: 3,
} as const;

/**
 * Flat score multiplier for a post the viewer was already SERVED in a previous
 * For-You page (Phase 7d — seen dampening). Applied LAST, after the additive
 * terms, so fresh content wins ties — but because it is a multiplier (not an
 * exclusion) a heavily-engaged post keeps enough score to resurface. Tunable.
 */
export const SEEN_RANK_PENALTY = 0.6;

/**
 * The default `For You` ranker (Phase 3, extracted to a strategy in Phase 7b).
 * A transparent additive function: recency + ERP-linked-author boost +
 * log-damped engagement + a rule-based persona term (skill overlap + the
 * viewer's intent vs the post's tags).
 */
@Injectable()
export class DefaultAdditiveStrategy implements FeedRankingStrategy {
  readonly key = 'default-additive';

  rank(posts: FeedPost[], signals: RankingSignals, ctx: RankingContext): FeedPost[] {
    return [...posts]
      .map((p) => ({ p, score: this.scorePost(p, signals, ctx.now) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }

  /** The `For You` score for a single post. */
  private scorePost(post: FeedPost, viewer: RankingSignals, now: number): number {
    let score = 0;

    const ageHours = Math.max(0, (now - post.createdAt.getTime()) / 3_600_000);
    score += RANK.recency * Math.exp(-ageHours / 24);

    if (post.authorErpLinked) score += RANK.erpLinked;

    score += RANK.engagement * Math.log1p(post.reactionCount + 2 * post.commentCount);

    const overlap = this.skillOverlap(viewer.skills, post.authorSkills);
    score += RANK.skillOverlap * Math.min(overlap, RANK.maxSkillOverlap);

    score += this.personaTagScore(viewer.openTo, post.tags);

    // Directional affinity — the viewer's recent engagement with this author,
    // capped so a single strong tie cannot dominate the feed. Absent / 0 for
    // cold-start users.
    const affinity = viewer.affinity?.get(String(post.authorId)) ?? 0;
    score += RANK.affinity * Math.min(affinity, RANK.maxAffinity);

    // Reader-feedback dampening (Phase 7d) — applied as multipliers AFTER the
    // additive terms so they down-rank without ever excluding. The per-post and
    // per-author factors are pre-decayed at fetch time (see feed-feedback.ts);
    // the seen penalty is a flat constant. All default to 1 (no effect).
    const id = String(post._id);
    score *= viewer.dampenByPost?.get(id) ?? 1;
    score *= viewer.dampenByAuthor?.get(String(post.authorId)) ?? 1;
    if (viewer.seenPostIds?.has(id)) score *= SEEN_RANK_PENALTY;
    // Demo/sample down-rank — the LAST multiplier (after seen dampening), so
    // seeded demo posts surface only when nothing else fills the slot while the
    // community grows. A down-rank, not an exclusion; keyed on Post.isDemo (the
    // same flag the FE "Sample" badge reads). Default false for real authors.
    score = applyDemoPenalty(score, post.isDemo === true);
    return score;
  }

  /** Case-insensitive count of skills shared by the viewer and the author. */
  private skillOverlap(viewerSkills: string[], authorSkills: string[]): number {
    if (viewerSkills.length === 0 || authorSkills.length === 0) return 0;
    const seen = new Set(viewerSkills.map((s) => s.toLowerCase().trim()));
    let n = 0;
    for (const skill of authorSkills) {
      if (seen.has(skill.toLowerCase().trim())) n += 1;
    }
    return n;
  }

  /**
   * The rule-based persona term — the viewer's `openTo` intent matched against
   * the post's tag keywords. A v1 heuristic over a loose tag vocabulary.
   *
   * The keyword sets include the romanized Gujarati / Hindi terms our markets
   * actually use (kaam, nokri/naukri, thok, bhaav, ...), so the boost fires for
   * the `gu-en` / `hi-en` locales, not only English — the prior English-only
   * regexes silently never matched non-English tags. Native Gujarati / Devanagari
   * script tags are still not covered (would need a transliteration / synonym
   * map); tracked as a follow-up.
   */
  private personaTagScore(viewer: RankingSignals['openTo'], tags: string[]): number {
    if (tags.length === 0) return 0;
    // Tags are normalized slugs (lowercased, hyphenated); match on the joined
    // text so a multi-word slug like `open-to-work` still hits `to work`.
    const text = tags.join(' ').replace(/-/g, ' ').toLowerCase();
    let score = 0;
    // A would-be employer is lifted toward people advertising availability.
    if (
      viewer.hiring &&
      /(open to work|available|looking for work|karigar|kaam joie|kaam chahiye|naukri chahiye)/.test(
        text,
      )
    ) {
      score += RANK.personaTag;
    }
    // A job-seeker is lifted toward hiring / requirement posts.
    if (
      viewer.work &&
      /(hiring|job|opening|requirement|vacancy|nokri|naukri|bharti|bharati|kaam)/.test(text)
    ) {
      score += RANK.personaTag;
    }
    // A buyer / seller is lifted toward deal + bulk-order posts.
    if (viewer.deals && /(bulk|deal|wholesale|order|stock|thok|bhaav|maal|holsale)/.test(text)) {
      score += RANK.personaTag;
    }
    // Someone open to custom orders is lifted toward custom-work posts.
    if (viewer.customOrders && /(custom|made to order|order made)/.test(text)) {
      score += RANK.personaTag;
    }
    return score;
  }
}
