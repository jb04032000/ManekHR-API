# Connect Feed Engine — hardening plan (data structures + algorithms)

Date: 2026-06-02
Inputs: internal read-only audit of `src/modules/connect/feed/**` + a cited
deep-research pass (ReBAC/Zanzibar, trending decay formulas, MongoDB TTL, fan-out
hybrids). Status: plan for owner approval. No code changed.

## What the research settled (high-confidence, primary-sourced)

- **Trending = materialize + cache**, recomputed periodically with a closed-form
  time-decay score. Canonical formulas: Hacker News gravity `score=(P-1)/(T+2)^1.8`,
  Reddit hot (`log10(votes) + sign*age/45000`), Wilson lower-bound for non-decaying
  "best". Per-request collection scans are the anti-pattern. (clux/decay, HN, Reddit,
  Evan Miller — verified 3-0.)
- **Visibility at write time.** Zanzibar/Leopard: precompute who-can-see-what at
  write/stream time so a restricted post is never fanned out to non-eligible viewers,
  avoiding O(connections) per-read graph checks; the "new enemy" stale-ACL leak is the
  exact unfollow case. We already hold the relationship tuples (`Connection`/`Follow`)
  — so we apply the _principle_ (gate at fan-out) without adopting SpiceDB. (AuthZed/
  Zanzibar USENIX — verified 3-0.)
- **MongoDB TTL reaper is single-threaded + batched** (50k docs OR 1s per index per
  cycle) — fine for best-effort GC, NOT for time-critical cleanup. So keep our explicit
  unfollow/delete GC; use TTL only for slow background trimming. (Mongo manual — 2-0.)
- **No celebrity hybrid at our scale.** The ~10k push/pull split + Cassandra/Redis
  patterns were all blog-sourced and refuted. Ship fan-out-on-write + capped timeline;
  defer the split until a real hot-author problem is measured. (refuted set.)

Research did NOT confirm (blog-only, refuted) the read-time dedup/diversity/cold-start-
pagination heuristics — those items below rest on the internal audit + engineering
judgment, not external evidence, and are scoped conservatively.

## The plan (severity-ordered; each ships BE + tests; no fabricated data)

### Tier A — safety + unbounded-growth + i18n correctness (urgent, cheap)

- **A1. Enforce `UserBlock` in the feed.** A `UserBlock` model exists but is wired ONLY
  into inbox/DM. The feed, all 4 discovery sources, the public post + profile reads
  never check it, so a blocking author's PUBLIC posts still reach a blocked viewer
  everywhere. Wire a block-set filter into discovery candidate queries + `getFeed`
  hydrate + the public post/activity reads (both directions). Global block, not DM-only.
- **A2. TTL the engagement log.** `EngagementEdge` (one `view` row per viewer-per-post)
  has NO TTL and is the fastest-growing collection. Add a TTL (e.g. 60-90d) on `view`
  edges (keep `repost` edges, or TTL longer). Aware of the slow reaper — it is
  background trimming, not time-critical.
- **A3. Fix persona-match i18n.** The ranker's persona boost uses English-only regexes
  (`/hiring|job|opening/`) that silently miss gu/gu-en/hi tag text. Match the actual
  tag/category slugs (language-agnostic), not English keywords.

### Tier B — structural correctness (the items proposed earlier)

- **B1. Write-time visibility gating.** In the fan-out processor, do NOT write
  `FeedEntry` rows for `connections`-only posts to non-connection followers (consult the
  author's connection set). Removes wasteful writes + stale rows + most read-time
  `gateVisibility` O(connections) cost. Keep the read-time gate as defense-in-depth.
- **B2. Trending materialization + cache.** A recurring BullMQ job recomputes a decayed
  trending score (HN gravity 1.8, tunable) into a small `connect_trending` set every
  ~10-15 min; `getTrendingRail` + the discovery `TrendingSource` read the materialized
  set instead of scanning the newest-200. Fixes "true virals outside the newest window
  are invisible" + the per-request scan.
- **B3. Complete the engagement log + add affinity to ranking.** Write `react` /
  `comment` / `share` `EngagementEdge` rows (today only `view`+`repost`), then add a
  directional **affinity** term to `DefaultAdditiveStrategy` (viewer→author interaction
  recency/count, decayed) — the canonical non-ML signal. Also de-noises network-out
  discovery (currently running off noisy view edges).

### Tier C — discovery depth + dedup (judgment; research thin)

- **C1. Discovery cursor for cold-start.** Paginate computed candidates (seen-state +
  an opaque discovery cursor) so a zero-network user gets infinite scroll, not one page
  then "caught up".
- **C2. Root dedup.** Dedup original-vs-repost within a page (key on `repostOf` root) so
  a viewer never sees the same root twice in one page.
- **C3. Bound the per-viewer loads.** Cap `getSeenPostIds` / negative-set / connection
  loads (paginate or limit) so feed reads don't load unbounded per-viewer sets; apply
  the author-diversity cap across the merged page (not per-list).

### Deferred (evidence says not needed yet)

- Celebrity pull/hybrid fan-out (refuted at our scale).
- Full SpiceDB/Zanzibar deployment (overkill; our collections are the tuples).
- MMR / topical diversity, Wilson-"best" surfaces (low value now).

## Recommended order

Tier A first (safety + a real unbounded-growth bug + an i18n correctness bug — all
small), then B (the structural correctness + the trending/affinity quality wins), then
C. Each tier is independently shippable and testable.
