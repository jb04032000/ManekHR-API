import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CANDIDATE_SOURCES,
  type CandidateSource,
  type CandidateContext,
  type ScoredCandidate,
} from './candidate-source.interface';
import { TtlLruCache } from '../feed-candidate-cache';
import { CANDIDATE_GEN_CACHE_TTL_MS, CANDIDATE_GEN_CACHE_MAX } from '../feed.constants';

/**
 * `FeedDiscoveryService` (Phase 7c) — the candidate-source orchestrator. Runs
 * every registered `CandidateSource` in parallel, merges their output (dedup by
 * post, keeping the strongest source score), drops posts the caller already has
 * in-network, and caps to the request limit. A failing source is isolated — it
 * logs and contributes nothing, so one bad source never empties the feed.
 *
 * The final feed ORDER is not set here — `FeedService` hands the merged pool to
 * the `FeedRankingStrategy`. This service only assembles + de-dups candidates.
 */
@Injectable()
export class FeedDiscoveryService {
  private readonly logger = new Logger(FeedDiscoveryService.name);

  /**
   * Per-viewer cache of the merged candidate POOL (the ~6-7-query fan-out across
   * all sources, deduped + sorted). The pool is page-AGNOSTIC: the page-specific
   * `excludeIds` (in-network + already-served) are applied FRESH on every call
   * below, so two pages 30s apart reuse one fan-out yet still exclude the right
   * posts and keep paginating. Keyed by viewer id only — `viewerSkills` /
   * `viewerDistrict` change rarely and the constant `limit` (pool is unsliced)
   * does not affect the pool, so the 60s TTL safely absorbs any drift. Native
   * `ObjectId`/`Date` objects, hence in-process (see `TtlLruCache`).
   */
  private readonly poolCache = new TtlLruCache<ScoredCandidate[]>(
    CANDIDATE_GEN_CACHE_TTL_MS,
    CANDIDATE_GEN_CACHE_MAX,
  );

  constructor(@Inject(CANDIDATE_SOURCES) private readonly sources: CandidateSource[]) {}

  async getCandidates(
    ctx: CandidateContext,
    excludeIds: ReadonlySet<string>,
  ): Promise<ScoredCandidate[]> {
    // Expensive stage (cached): build the full merged pool. Cheap stage (fresh):
    // drop the page's excluded ids, then take the top `limit`. Exclude-then-slice
    // (vs the old skip-during-merge) yields the identical final set + order — the
    // sort key is `sourceScore`, untouched by which ids are excluded.
    const pool = await this.getCandidatePool(ctx);
    const out: ScoredCandidate[] = [];
    for (const candidate of pool) {
      if (out.length >= ctx.limit) break;
      if (excludeIds.has(String(candidate.post._id))) continue;
      out.push(candidate);
    }
    return out;
  }

  /**
   * The merged, deduped, score-sorted candidate pool for a viewer — NOT excluded
   * and NOT sliced (that is the caller's per-page concern). Cached per viewer for
   * `CANDIDATE_GEN_CACHE_TTL_MS`; a miss runs every source in parallel (a failing
   * source contributes nothing). This is the single most expensive part of a
   * For-You read, so caching it is what keeps a warm page within the query budget.
   */
  private async getCandidatePool(ctx: CandidateContext): Promise<ScoredCandidate[]> {
    const key = String(ctx.viewerId);
    const cached = this.poolCache.get(key, ctx.now);
    if (cached) return cached;

    const lists = await Promise.all(
      this.sources.map((source) =>
        source.fetch(ctx).catch((err) => {
          this.logger.error(`Candidate source '${source.key}' failed: ${(err as Error)?.message}`);
          return [] as ScoredCandidate[];
        }),
      ),
    );

    // Dedup by post; a post surfaced by several sources keeps its strongest score.
    const byPost = new Map<string, ScoredCandidate>();
    for (const list of lists) {
      for (const candidate of list) {
        const id = String(candidate.post._id);
        const existing = byPost.get(id);
        if (!existing || candidate.sourceScore > existing.sourceScore) {
          byPost.set(id, candidate);
        }
      }
    }

    const pool = [...byPost.values()].sort((a, b) => b.sourceScore - a.sourceScore);
    this.poolCache.set(key, pool, ctx.now);
    return pool;
  }

  /**
   * Trending candidates ONLY — powers the feed right-rail "Trending in your
   * trade" panel (a compact, viewer-agnostic list), separate from the
   * personalized in-feed mix. Isolated like `getCandidates`: a source failure
   * yields an empty rail, never an error.
   */
  async getTrending(ctx: CandidateContext): Promise<ScoredCandidate[]> {
    const source = this.sources.find((s) => s.key === 'trending');
    if (!source) return [];
    return source.fetch(ctx).catch((err) => {
      this.logger.error(`Trending source failed: ${(err as Error)?.message}`);
      return [] as ScoredCandidate[];
    });
  }
}
