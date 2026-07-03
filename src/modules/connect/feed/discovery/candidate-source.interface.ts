import type { Types } from 'mongoose';
import type { FeedPost } from '../feed.service';

/**
 * A feed candidate produced by a `CandidateSource` — a post plus why it
 * surfaced. `origin` + `reason` flow to the UI so a discovery item can carry an
 * honest label ("Trending in your trade", "Because you do Zari").
 */
export interface ScoredCandidate {
  post: FeedPost;
  /** The source's own relevance score (higher = stronger). Used to merge + cap
   *  across sources; the final feed order is set by `FeedRankingStrategy`. */
  sourceScore: number;
  /** Where it came from — `in_network` | `trending` | `topic` | `geo` | … */
  origin: string;
  /** i18n key (or pre-resolved string) for the "why am I seeing this" chip. */
  reason?: string;
}

/** Per-request context handed to every candidate source. */
export interface CandidateContext {
  viewerId: Types.ObjectId;
  /** `Date.now()` captured once for the request (stable recency math). */
  now: number;
  /** Max candidates the source should return. */
  limit: number;
  /**
   * The viewer's declared skills / trades — populated once by `FeedService`
   * from the ranking signals it already loads, so a source (e.g. TopicMatch)
   * personalises without its own profile round-trip. Empty for a viewer with
   * no declared skills.
   */
  viewerSkills: string[];
  /** The viewer's home district — powers GeoLocal. Optional / '' when unset. */
  viewerDistrict?: string;
}

/**
 * A pluggable feed candidate source (Phase 7c). Discovery (`trending`, `topic`,
 * `geo`, …) and — later — monetization (`sponsored`, `boosted`, `house`) each
 * implement this. The orchestrator (`FeedDiscoveryService`) runs them in
 * parallel, merges + dedups + caps, and the `FeedRankingStrategy` orders the
 * result. New sources register via the `CANDIDATE_SOURCES` multi-provider with
 * NO change to the read path.
 */
export interface CandidateSource {
  /** Stable id, also the default `origin` of its candidates. */
  readonly key: string;
  fetch(ctx: CandidateContext): Promise<ScoredCandidate[]>;
}

/** DI token — the array of registered `CandidateSource`s (multi-provider). */
export const CANDIDATE_SOURCES = Symbol('CANDIDATE_SOURCES');
