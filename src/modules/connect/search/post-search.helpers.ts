/**
 * Pure helpers for Connect feed-post search (search redesign Phase B). No Nest,
 * no Mongoose, so they unit-test without the decorator-metadata pipeline and are
 * shared by the Meili and Mongo backends in SearchService.
 *
 * Mirrors `listing-search.helpers.ts` so the verticals stay shape-symmetric and
 * the federation layer fans out to all of them without per-vertical hacks.
 *
 * Only PUBLIC, non-deleted, ORIGINAL posts reach the index (the indexer purges
 * everything else): a `connections`-visibility or soft-deleted post is never
 * searchable, and a pure repost is skipped so search never shows a duplicate of
 * its original. The hydration re-pins the public gate so a stale index row
 * cannot leak a now-private post.
 */

import { Types } from 'mongoose';
import type { PostKind } from '../feed/schemas/post.schema';
import { romanizedIndexField } from './transliteration';

/** Buyer-side filter knobs threaded through feed-post search. */
export interface PostSearchFilters {
  /** Restrict to one post kind (text / photo / video / document / voice). */
  kind?: PostKind;
  /** Restrict to a single author's posts. */
  authorId?: string;
}

/** Escape a value for a double-quoted Meilisearch filter literal. */
function quoteMeili(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** True when at least one facet is set. */
export function hasPostFilters(filters: PostSearchFilters): boolean {
  return Boolean(filters.kind || filters.authorId);
}

/**
 * The indexed post document. One per public + non-deleted + original post.
 * `body` + `hashtags` are searchable; `engagementScore` + `createdAt` are the
 * numeric ranking signals (a popular recent post outranks an old quiet one once
 * relevance ties), mirroring the listing index's `searchPriority` + recency.
 */
export interface ConnectPostDocument {
  id: string;
  authorId: string;
  body: string;
  hashtags: string[];
  kind: PostKind;
  /** SRCH-I18N-1: Latin romanization of any Gujarati-script body/hashtag tokens,
   *  so a Latin query finds Gujarati-script content. Lowest-rank searchable;
   *  `''` for an all-Latin post. Not displayed. */
  romanized: string;
  /** Author trust signal, denormalized (mirrors people / listings `erpLinked`). */
  authorErpLinked: boolean;
  /** reactions + comments + reposts; numeric ranking rule + sortable. */
  engagementScore: number;
  /** Unix ms so Meili's `createdAt:desc` ranking rule sorts numerically. */
  createdAt: number;
  /**
   * Demo Content scope: 0 for a real post, 1 for a seeded sample one (read from
   * the post's denormalized `isDemo`). Numeric so the `demoRank:asc` ranking rule
   * sinks demo below an otherwise-equal real tie. Same flag the web "Sample"
   * badge + demo-rank.ts down-rank read.
   */
  demoRank: number;
}

/** Minimal post slice {@link buildPostDocument} needs. */
export interface PostForIndex {
  _id: Types.ObjectId | string;
  authorId: Types.ObjectId | string;
  body?: string;
  hashtags?: string[];
  kind: PostKind;
  authorErpLinked?: boolean;
  reactionCount?: number;
  commentCount?: number;
  repostCount?: number;
  createdAt?: Date;
  /** Denormalized seeded-sample marker (Demo Content scope), stamped at create
   *  from the author's `User.isDemo`. Defaults to false on a legacy row. */
  isDemo?: boolean;
}

/** Map a post into the indexed shape. */
export function buildPostDocument(post: PostForIndex): ConnectPostDocument {
  return {
    id: String(post._id),
    authorId: String(post.authorId),
    body: (post.body ?? '').trim(),
    hashtags: post.hashtags ?? [],
    kind: post.kind,
    romanized: romanizedIndexField(post.body, post.hashtags),
    authorErpLinked: post.authorErpLinked ?? false,
    engagementScore: (post.reactionCount ?? 0) + (post.commentCount ?? 0) + (post.repostCount ?? 0),
    createdAt: (post.createdAt ?? new Date()).getTime(),
    // 0 real / 1 demo so the `demoRank:asc` rule sinks seeded sample posts.
    demoRank: post.isDemo ? 1 : 0,
  };
}

/**
 * Public post card shape - the federation result row for a post. A slim,
 * render-ready projection the post result card consumes directly. The author's
 * public identity (name / avatar / handle) is hydrated separately by the search
 * service (a batch lookup, never N+1), so this carries only the post fields.
 */
export interface ConnectPostRef {
  postId: string;
  authorId: string;
  /** Body trimmed to a card-friendly snippet. */
  snippet: string;
  kind: PostKind;
  /** First image / video attachment URL, or null for a text / voice post. */
  coverImage: string | null;
  reactionCount: number;
  commentCount: number;
  createdAt: Date;
}

/** Minimal post slice {@link toPostRef} needs. */
export interface PostForRef {
  _id: Types.ObjectId | string;
  authorId: Types.ObjectId | string;
  body?: string;
  kind: PostKind;
  media?: Array<{ url: string; type: string }>;
  reactionCount?: number;
  commentCount?: number;
  createdAt?: Date;
}

/** Max snippet length before an ellipsis is appended. */
const SNIPPET_MAX = 160;

/** Map a (lean) Post into the federation card shape. */
export function toPostRef(post: PostForRef): ConnectPostRef {
  const body = (post.body ?? '').trim();
  const cover = post.media?.find((m) => m.type === 'image' || m.type === 'video')?.url ?? null;
  return {
    postId: String(post._id),
    authorId: String(post.authorId),
    snippet: body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX).trimEnd()}...` : body,
    kind: post.kind,
    coverImage: cover,
    reactionCount: post.reactionCount ?? 0,
    commentCount: post.commentCount ?? 0,
    createdAt: post.createdAt ?? new Date(),
  };
}

/**
 * Meilisearch `filter` clauses (AND-ed) for post search. The index holds only
 * public posts (the indexer guarantees it), so visibility is not a clause here;
 * facets narrow by kind / author.
 */
export function buildPostMeiliFilter(filters: PostSearchFilters): string[] {
  const clauses: string[] = [];
  if (filters.kind) clauses.push(`kind = ${quoteMeili(filters.kind)}`);
  if (filters.authorId) clauses.push(`authorId = ${quoteMeili(filters.authorId)}`);
  return clauses;
}

/**
 * Mongo conditions for the post-search fallback. ALWAYS pins the public gate
 * (`visibility: 'public'`, not soft-deleted, original-not-repost) so the Mongo
 * path can never surface a private / deleted / repost row.
 */
export function buildPostMongoConditions(filters: PostSearchFilters): Record<string, unknown> {
  const conditions: Record<string, unknown> = {
    visibility: 'public',
    deletedAt: null,
    repostOf: null,
  };
  if (filters.kind) conditions.kind = filters.kind;
  if (filters.authorId) conditions.authorId = new Types.ObjectId(filters.authorId);
  return conditions;
}
