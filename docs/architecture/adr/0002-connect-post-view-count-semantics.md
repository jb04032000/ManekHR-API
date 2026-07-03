# ADR-0002: Connect post view-count semantics (lifetime-unique, author-only)

**Status:** Proposed
**Date:** 2026-06-17
**Deciders:** Owner (product call made: view counts are author-only, LinkedIn model)

## Context

The Connect feed shows a per-post view count ("N views"). The owner reported a
post showing 16-20 views when the workspace had "only 2 members."

Investigation (read-only) established the count is NOT a bug in normal use:

- A view is recorded only for an **authenticated** viewer who dwells on the post
  (`FeedController.recordViews`, class-guarded by `JwtAuthGuard`). The public
  permalink controller (`FeedPublicController`) is read-only — anonymous traffic
  cannot inflate the count.
- The author's own views are excluded (`recordViews` filters
  `!viewer.equals(p.authorId)`).
- Dedup is enforced by a unique index `{ actorId, postId, type }` on
  `EngagementEdge`; `Post.viewCount` is `$inc`'d only when a NEW `view` edge is
  inserted (`feed.service.ts` `recordViews`). There is exactly one increment
  site in the codebase.
- The seed ships **18 demo personas** (`scripts/connect-demo/content.ts`). Each
  demo account that browses the feed is a legitimate distinct authenticated
  viewer, so ~16-20 unique views on a post is the expected, correct number for
  that test network. "2 members" referred to ERP workspace members, a different
  population from Connect network viewers.

Two real correctness gaps surfaced during the investigation:

1. **Count drift via TTL expiry.** `EngagementEdge` carries a partial TTL that
   expires `view` rows after `ENGAGEMENT_VIEW_TTL_DAYS = 90`
   (`engagement-edge.schema.ts`). The dedup backstop for a `(viewer, post)` pair
   is the `view` edge itself. Once it expires, the same viewer re-viewing the
   post inserts a fresh edge and `viewCount` is `$inc`'d **again**. So the stored
   count is neither a true lifetime-unique tally nor a true rolling-window count
   — it drifts upward over time. Rare today (old posts seldom resurface to the
   same viewer after 90 days) but real, and it grows the longer a post lives.

2. **Demo views baked into real counts.** The admin demo purge
   (`AdminConnectDemoService.purge`) deletes demo posts/reactions/comments but
   does NOT (a) delete `connectengagementedges` / `connectseenposts` rows
   actored-by or authored-by demo users, nor (b) recompute the denormalized
   `viewCount` (or `reactionCount` / `commentCount`) on **real** posts that demo
   accounts engaged with. After purging demo accounts, a real post keeps the
   views the demo accounts gave it.

This ADR decides the **storage + semantics** of the view count. The display
decision (author-only) is a product call already made and is captured in the
companion design spec; it is not re-litigated here.

## Decision

Define `Post.viewCount` as **lifetime unique viewers**: each authenticated
non-author person counts exactly once for a given post, for the life of the
post, and is never re-counted.

To make that definition honest while keeping storage bounded:

- **Remove the 90-day partial TTL on `view` `EngagementEdge` rows** so the
  per-`(viewer, post)` dedup marker is permanent for the post's life.
- **Preserve discovery recency** by adding an explicit `createdAt >= now - 90d`
  window to the network-out discovery query that traverses `view` edges (the TTL
  previously enforced this implicitly). Discovery behavior is unchanged; only the
  rows' lifetime changes.
- **Bound storage by content lifecycle, not a clock:** cascade-delete a post's
  `view` edges (and its `SeenPost` rows) when the post is deleted.
- **`SeenPost` keeps its own TTL** (`SEEN_RETENTION_SECONDS`) — seen-suppression
  is meant to be temporary so posts can resurface in discovery. It is not the
  count dedup and must not be made permanent.
- **Demo purge becomes count-honest:** delete demo-related edges + seen rows and
  recompute `viewCount` / `reactionCount` / `commentCount` on affected real posts
  from the surviving rows.

## Options Considered

### Option A: Un-TTL the `view` edge (chosen)

Reuse the edge already written on every impression as the permanent count-dedup
marker; add a recency filter to the discovery query; cascade-delete on post
delete.

| Dimension        | Assessment                                                                     |
| ---------------- | ------------------------------------------------------------------------------ |
| Complexity       | Low — one schema index removed, one query guard, one cascade                   |
| Write cost       | None added — reuses the existing edge write on the hot path                    |
| Scalability      | Storage grows with engagement, bounded by post deletion; fine at current scale |
| Team familiarity | High — same collection + patterns already in use                               |

**Pros:** No new collection; zero extra writes on the highest-volume endpoint;
makes the count honest with the smallest diff; storage is proportional to real
content, not unbounded by a clock.
**Cons:** Overloads one collection with two lifetimes (discovery recency now
enforced in the query rather than by the index); `view` edge collection is
larger than before for long-lived popular posts.

### Option B: Dedicated permanent count-dedup collection

Keep the `view` edge TTL'd at 90 days for discovery; add a separate tiny
`(viewerId, postId)` collection with no TTL used solely for count dedup.

| Dimension        | Assessment                                            |
| ---------------- | ----------------------------------------------------- |
| Complexity       | Medium — new collection, schema, index, cascade       |
| Write cost       | +1 write per impression batch on the hot path (+~50%) |
| Scalability      | Same storage as A, cleaner separation of concerns     |
| Team familiarity | Medium                                                |

**Pros:** Clean separation — discovery edge stays recency-bounded, count dedup is
its own concern.
**Cons:** Adds write amplification on the hottest endpoint; one more collection
to maintain and cascade. Not justified at current scale.

### Option C: Probabilistic unique count (HyperLogLog per post)

Store an HLL sketch per post; add each viewer to it; read the cardinality.

| Dimension        | Assessment                                         |
| ---------------- | -------------------------------------------------- |
| Complexity       | High — sketch lib, serialization, merge semantics  |
| Write cost       | Per-impression sketch update                       |
| Scalability      | Excellent — fixed bytes per post, no per-pair rows |
| Team familiarity | Low                                                |

**Pros:** Bounded storage regardless of volume; the standard answer at very large
scale.
**Cons:** Approximate (±~2%), heavy machinery for a small network, loses the
per-pair edge that discovery also relies on. Over-engineered for this stage.

## Trade-off Analysis

The hot path is `recordViews` (every impression of every viewer). Minimizing
writes there matters more than collection tidiness at this scale, which rules out
B. C buys bounded storage we do not yet need and gives up the exact, per-pair
edge that network-out discovery uses. A makes the count correct with the smallest
change and no extra hot-path writes; its only real cost — a larger `view` edge
collection — is bounded by content (cascade on delete) and revisitable. When the
network is large enough that `view` edge storage hurts, C becomes the migration
target.

## Consequences

- **Easier:** `viewCount` becomes a trustworthy lifetime-unique number; the
  author-only display shows an honest figure; demo purge no longer leaves
  inflated real counts.
- **Harder / to watch:** discovery recency now depends on a query-level window
  rather than the TTL — that filter must not be dropped. The `view` edge
  collection loses its automatic trimming, so growth is now tied to keeping the
  post-delete cascade correct.
- **Revisit when:** the `view` edge collection grows large enough to pressure
  storage/index memory — migrate to Option C (HLL).

## Action Items

1. [ ] Remove the `engagement_view_ttl` partial TTL index from
       `engagement-edge.schema.ts`; drop the existing index on the live DB.
2. [ ] Add a `createdAt >= now - ENGAGEMENT_VIEW_TTL_DAYS` window to the
       network-out discovery query that scans `view` edges (preserve recency).
3. [ ] Cascade-delete a post's `view` edges + `SeenPost` rows on post delete.
4. [ ] Make `AdminConnectDemoService.purge` delete demo-related edges + seen rows
       and recompute `viewCount` / `reactionCount` / `commentCount` on affected
       real posts.
5. [ ] One-off reconciliation for existing data: recompute `viewCount` from
       surviving `view` edges after demo cleanup (the design spec covers this).
6. [ ] Tests: re-view after the old TTL window does not double-count; self-view
       and anonymous never count; demo purge leaves honest real counts.
