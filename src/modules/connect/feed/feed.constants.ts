/**
 * ManekHR Connect — Feed module shared constants (Phase 3).
 *
 * Kept in its own file (not on `ConnectFeedModule`) so `FeedService` and the
 * fan-out processor can import it without a service ↔ module circular import.
 */

/** The BullMQ queue that fans a new post out into follower `FeedEntry` rows. */
export const FEED_FANOUT_QUEUE = 'connect-feed-fanout';

/** Posts returned per feed page (the read window — `phase-3-feed.md` B3). */
export const FEED_PAGE_SIZE = 20;

/**
 * How many of a peer's most-recent posts are copied into the other peer's feed
 * when a connection is accepted. Fan-out is on-write, so a post made BEFORE the
 * connection existed would never reach the new follower without this backfill.
 */
export const BACKFILL_LIMIT = 20;

// ── Discovery (Phase 7c — For-You candidate sourcing) ──────────────────────

/** Trending window — only posts from the last N days are discovery candidates. */
export const TRENDING_WINDOW_DAYS = 14;
/** Max recent public posts a single source scans before scoring (caps the read). */
export const DISCOVERY_SCAN_LIMIT = 200;
/** Max discovery candidates the orchestrator returns to enrich a feed page. */
export const DISCOVERY_CANDIDATE_LIMIT = 30;

/** Author-diversity cap — at most N posts from one author in a For-You page. */
export const MAX_POSTS_PER_AUTHOR = 3;

// ── Trending materialization (B2 — periodic recompute + cache) ──────────────

/** Cron for the trending refresh job (every 15 minutes). */
export const TRENDING_REFRESH_CRON = '*/15 * * * *';
/** The job scores public posts from the last N days (broader than the per-request
 *  window, so a viral post older than the newest slice is still captured). */
export const TRENDING_MATERIALIZE_WINDOW_DAYS = 30;
/** Max posts the refresh job scans + scores per run (bounds the job cost). */
export const TRENDING_MATERIALIZE_SCAN_LIMIT = 1000;
/** How many top-scored posts the job persists into the materialized set. */
export const TRENDING_MATERIALIZE_TOP_N = 100;
/** Hacker-News gravity exponent for the time-decay popularity score. */
export const TRENDING_GRAVITY = 1.8;

// ── Affinity ranking (B3 — directional interaction signal) ──────────────────

/** Trailing window (days) of the viewer's engagement used to build affinity. */
export const AFFINITY_WINDOW_DAYS = 60;
/** Max engagement rows scanned per feed read to build the affinity map. */
export const AFFINITY_SCAN_LIMIT = 500;

// ── For-You candidate-generation cache (read-path perf) ──────────────────────
//
// The expensive For-You stage — discovery candidate generation (~6-7 Mongo
// reads across the 4 sources) plus the per-viewer scoring inputs (ranking
// signals + affinity map) — is cached per viewer for a short window so back-to-
// back page fetches and rapid refreshes reuse it instead of re-running the full
// fan-out. The cache holds ONLY stable scoring inputs; the volatile filters that
// must apply instantly (hide / mute / block / seen / dampening) are read FRESH
// every page AFTER the cached stage, so a warm cache never serves a hidden or
// blocked post. 60s staleness is acceptable: a brand-new post or a fresh
// not-interested mark simply takes effect within a minute, which the spec allows.

/** TTL for the For-You candidate-generation cache (signals + affinity + pool). */
export const CANDIDATE_GEN_CACHE_TTL_MS = 60_000; // 60s — see note above.
/** Hard cap on cached viewers (LRU-evicted past it) — bounds process memory. */
export const CANDIDATE_GEN_CACHE_MAX = 5_000;

// ── Cold-start discovery pagination (C1) + bounded loads (C3) ────────────────

/**
 * Sentinel cursor for the For-You discovery continuation (C1). Once a viewer's
 * in-network timeline is exhausted, the feed returns this cursor so the client
 * keeps paginating PURE discovery (each page's served candidates are marked seen
 * so the next page is fresh) — a zero/low-network user gets infinite scroll, not
 * one page. It is intentionally not a date, so the in-network query is skipped.
 */
export const DISCOVERY_CURSOR = 'discovery';
/** Cap on the most-recent seen-post ids loaded per feed read (bounds the read). */
export const SEEN_LOAD_LIMIT = 3000;

// ── Impressions (Phase 7c — post views + seen-suppression) ─────────────────

/**
 * How long a `SeenPost` row lives. While present, the post is suppressed from
 * the viewer's For-You DISCOVERY candidates so the same trending / topic post
 * does not reappear every refresh. After the TTL it may resurface. The
 * Following tab is never seen-filtered (chronological truth).
 */
export const SEEN_RETENTION_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** Max post ids accepted in one `recordViews` impression batch (bounds the write). */
export const VIEW_BATCH_MAX = 50;

// ── Per-(user,post) comment anti-spam (engagement abuse guard) ──────────────
//
// These cap how hard ONE member can hammer a SINGLE post's comment thread.
// The global `connect-engage` throttle (90/min) is account-wide, so without
// these a member could legally drop 90 comments on one post in a minute or
// duplicate-fire via network retries. Enforced in `CommentService.addComment`
// by counting the member's own prior comments on that post (indexed query on
// `authorId + postId + createdAt`), which is exact, survives a process restart
// (unlike an in-memory limiter), and needs no extra store — the comments
// collection is already the source of truth.
//
// All four are TUNABLE — bump them if real usage proves them tight.

/** Short-window cap: max comments one member may post on one post per 10 min. */
export const COMMENT_RATE_LIMIT_SHORT = 10;
/** The short window, in milliseconds (10 minutes). */
export const COMMENT_RATE_WINDOW_SHORT_MS = 10 * 60 * 1000;
/** Daily cap: max comments one member may post on one post per 24 hours. */
export const COMMENT_RATE_LIMIT_DAY = 60;
/** The daily window, in milliseconds (24 hours). */
export const COMMENT_RATE_WINDOW_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Duplicate-suppression window: an identical comment (same author, same post,
 * same normalized body) re-submitted within this many milliseconds of the
 * previous one is treated as a retry — the existing comment is returned instead
 * of creating a second row. Catches double-taps and network retries that the
 * optional `Idempotency-Key` header did not cover.
 */
export const COMMENT_DUPLICATE_WINDOW_MS = 30 * 1000;
