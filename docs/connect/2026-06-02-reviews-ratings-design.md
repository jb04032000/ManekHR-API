# Connect Reviews & Ratings (marketplace Phase C) — design

Date: 2026-06-02
Inputs: marketplace-redesign epic Phase C decisions (owner-locked) + the deep-
research finding that the **Wilson score lower bound** is the right
non-time-decaying "quality" aggregate for star ratings. Trust is the network's
moat; this is the trust layer that threads through profile / company / marketplace.

## Locked product decisions (from the marketplace epic)

- **Open to all signed-in members** initially — do NOT gate on a proven transaction
  (we cannot yet prove one). A `verifiedPurchase` flag is RESERVED (false now) so a
  later transaction-gating / weighting drops in with no migration.
  `// TODO(review-trust): gate / weight by a real inquiry or transaction signal.`
- **One review per buyer-seller**, editable (upsert).
- **Self-review blocked.**
- **Reportable.** No fabricated ratings — a rating renders ONLY when `ratingCount > 0`.

## Data model

- **`Review`** (`connect_reviews`): `reviewerUserId`, `subjectUserId` (the rated
  seller/person), `rating` (1-5 int), `text?` (<= 1000), `verifiedPurchase`
  (default false, reserved), `status` ('active' | 'hidden'), `reportCount`
  (default 0). Indexes: `{reviewerUserId, subjectUserId}` unique (one-per-pair,
  editable), `{subjectUserId, status, createdAt: -1}` (list).
- **`SellerRating`** (`connect_seller_ratings`): denormalized aggregate per
  `subjectUserId` (unique) so every card/header reads one doc, no per-render
  recompute: `ratingCount`, `ratingAvg` (display), `positiveCount` (>=4 stars),
  `wilsonScore` (sort key for "top rated"), `updatedAt`. Recomputed on each review
  write/delete (review counts per seller are modest; full recompute is bounded).

### Wilson lower bound (the aggregate math)

For a 5-star system, treat `rating >= 4` as a "positive". With `p = positive/n`
and `z = 1.96` (95%):
`wilson = (p + z^2/2n - z*sqrt((p(1-p) + z^2/4n)/n)) / (1 + z^2/n)`.
`wilsonScore` ranks "best" sellers without small-sample inflation (a single
5-star does not outrank a 4.6 over 50). `ratingAvg` is what's DISPLAYED.

## Endpoints (`/connect/reviews`, JwtAuthGuard unless @Public)

- `POST /connect/reviews` — upsert my review `{subjectUserId, rating, text?}`.
  Self-review blocked; recompute aggregate; audit + PostHog. Throttled.
- `DELETE /connect/reviews/:subjectUserId` — delete my review; recompute.
- `GET /connect/reviews/me/:subjectUserId` — my existing review (edit form).
- `@Public GET /connect/reviews/seller/:subjectUserId` — paginated active reviews
  - the aggregate (reviewer identity hydrated by the web).
- `POST /connect/reviews/:reviewId/report` — increment `reportCount` (audited);
  auto-hide hook reserved (`// TODO(review-mod)`).

## Surfacing (R2)

The aggregate `{ratingAvg, ratingCount}` is folded into the existing reads:

- public profile read (profile header stars),
- public company-page read (header + the reserved Reviews tab),
- the marketplace listing search ref / listing public read (the rating slot the
  grid card already reserved). Only renders when `ratingCount > 0`.

## Web (R3)

- A `ReviewForm` (1-5 stars + optional text; "edit your review" when one exists).
- A `ReviewList` (stars + reviewer + text + relative time + report).
- A compact `RatingStars` display atom for profile/company/listing cards.
- Company page **Reviews tab** (already reserved as net-new in `CompanyPageView`).
- i18n across en / gu / gu-en / hi-en (gu/gu-en/hi-en owe native review).

## Anti-abuse (v1, honest)

One-per-pair (unique index), self-review blocked, rate-limited, reportable. No
auto-moderation ML; report increments a counter + audits, with a reserved
auto-hide threshold hook. `verifiedPurchase` reserved for the future trust gate.

## Build order

R1 backend foundation (schema + service + endpoints + tests) → R2 surface the
aggregate on the three reads → R3 web UI. Each ships with tests + i18n and is
independently committable.
