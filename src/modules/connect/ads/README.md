# Connect Ads - placement map & fairness

First-party ad engine for Connect (boosts + house promos). One decision service
(`ad-decision.service.ts`) serves every placement; the web mounts a component per
surface and calls `POST /connect/ads/decide` (SSR or client) to fill it.

This doc is the canonical placement inventory and the fairness contract. Keep the
table in sync with the seed in `ads.module.ts` and the web mounts.

## Placement inventory

All seeded placements carry `floorCpm = 0` today (no floor/pricing changes here).
`surface` is constrained to `feed | rail` by the schema; in-content listing slots
(grid, search row) reuse `rail`.

| Placement key (BE)   | Floor CPM | Web mount (surface)                                                         | Target-map rule                                                                                                | Status                                      |
| -------------------- | --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `feed_promoted_post` | 0         | `FeedList` in-stream via `decideAd` (feed page)                             | feed: max 1 sponsored / ~20-item page                                                                          | Live end-to-end                             |
| `marketplace_rail`   | 0         | marketplace browse right rail via `resolvePromotedRailListing`              | rail: 1 first-party boost slot                                                                                 | Live end-to-end                             |
| `marketplace_grid`   | 0         | `MarketplaceGridAdCell` in browse grid                                      | grid: first-party boost PINNED at top (row 1, all breakpoints); Google fallback ~1 / 12 cells, never first row | Live end-to-end (boost pins at top)         |
| `company_page`       | 0         | `EntityAdRail` on `/connect/company/[slug]`                                 | rail: 1 first-party boost slot                                                                                 | Live end-to-end                             |
| `storefront_page`    | 0         | `EntityAdRail` on `/connect/store/[slug]`                                   | rail: 1 first-party boost slot                                                                                 | Live end-to-end                             |
| `rfq_board`          | 0         | `EntityAdRail` on `/connect/rfq`                                            | RFQ: max 1 sponsored / page (sparse)                                                                           | Live end-to-end (single rail slot = 1/page) |
| `rfq_detail`         | 0         | `EntityAdRail` on `/connect/rfq/[id]`                                       | RFQ: max 1 sponsored / page (sparse)                                                                           | Live end-to-end                             |
| `jobs_rail`          | 0         | jobs board promoted job (read-only `JobBoostResolverService`, not `decide`) | rail: 1 first-party boost slot                                                                                 | Live end-to-end                             |
| `search_results`     | 0         | `SearchResultsScreen` sponsored row (listings + all verticals)              | search: 1 sponsored row, labelled, never first                                                                 | Live end-to-end (added in this pass)        |

### External (AdSense) rail/grid slot

The target map's "1 external slot" on the rail and the grid/search fallbacks are
served by `GoogleAdUnit` / `AdSlot` (env-gated on `adSenseClientId` +
`adSenseSlots[...]`). When the AdSense env is **unset** they render nothing and
reserve no space (byte-identical to a no-ads deploy). When **set** they serve
compliantly with zero further code change - see "AdSense serving readiness" below
for the env vars, the ads.txt mechanism, the fallback chain, and the owner
go-live checklist.

### Removed

- `CompanyDirectoryAdCell` + the `CompanyDirectoryScreen` that mounted it: the
  companies directory (`/connect/companies`) is an owner-decided non-user-facing
  surface (the page redirects), so the cell was dead code and has been deleted.

## Fairness controls (apply to ALL placements, in the decision service)

These run inside `AdDecisionService.decide` so every placement gets them for free.
`AdFairnessService` (Redis) backs the cap + dedupe; `lib/rotation.ts` is the pure
rotation helper.

1. **Daily campaign frequency cap (C4).** A viewer sees at most
   `CAMPAIGN_DAILY_CAP = 2` impressions of the same campaign per UTC day. Read-only
   check during candidate filtering (never burns the cap for a loser); the winner
   records one serve. Redis key `adcap:day:{viewerKey}:{campaignId}:{YYYY-MM-DD}`,
   self-expiring. This is the platform's cross-placement guard, distinct from the
   advertiser's own per-ad-set window in `FrequencyCapService`.

2. **Per-page dedupe (C5).** Within one page render, a campaign serves at most once
   across ALL slots (e.g. marketplace rail + grid). The page passes a
   `pageRequestId` (uuid) on every `decide` call for that render; served campaigns
   are recorded in a short-lived Redis set `adpage:{pageRequestId}` (120s TTL) and
   excluded from later slots. Absent `pageRequestId` means dedupe is a no-op
   (single-slot pages). Web threads one id through `resolvePromotedRailListing` on
   the marketplace page.

3. **Equal-bid rotation (C6).** Among candidates within `EQUAL_BID_EPSILON = 0.001`
   of the top score, the winner is chosen at random (`pickTopWithRotation`) so equal
   bidders share inventory instead of one always winning.

4. **Telemetry (C7).** The `ads.auction_decided` event gained
   `frequency_capped` and `page_deduped` counts in its properties (and the log
   line), so a thin/empty slot is explainable by the fairness filters.

### Anonymous / logged-out viewers

`POST /connect/ads/decide` is `JwtAuthGuard`-protected, so **every caller has a
stable `userId`** so the daily cap and dedupe always key off a real viewer id.
There is no anonymous decide path to handle (the env-gated AdSense slots fill
client-side and never hit `decide`), so no session/device fallback key is needed.

## AdSense serving readiness (web)

Everything below the env layer is built and tested. Once the owner creates an
AdSense account and sets the keys, ads serve correctly and compliantly with **no
further code change**. Without the keys, the web behaves byte-identically to today.

### Env vars (crewroster-web, all `NEXT_PUBLIC_*`, read via `lib/env`)

| Var                                         | Example           | Purpose                                          |
| ------------------------------------------- | ----------------- | ------------------------------------------------ |
| `NEXT_PUBLIC_ADSENSE_CLIENT_ID`             | `ca-pub-XXXXXXXX` | Publisher id. Empty = AdSense OFF (master gate). |
| `NEXT_PUBLIC_ADSENSE_SLOT_RIGHT_TOP`        | `1234567890`      | Slot id for the right-rail top placement.        |
| `NEXT_PUBLIC_ADSENSE_SLOT_RIGHT_MID`        | `1234567890`      | Slot id for the right-rail mid placement.        |
| `NEXT_PUBLIC_ADSENSE_SLOT_LEFT_TOP`         | `1234567890`      | Slot id for the left-rail top placement.         |
| `NEXT_PUBLIC_ADSENSE_SLOT_DIRECTORY_GRID`   | `1234567890`      | Slot id for the in-grid directory cell.          |
| `NEXT_PUBLIC_ADSENSE_SLOT_MARKETPLACE_GRID` | `1234567890`      | Slot id for the in-grid marketplace cell.        |

A slot fills only when BOTH the publisher id and that slot's id are set; any
missing slot simply renders nothing. These are build-time (`NEXT_PUBLIC_*`)
values, so a deploy/rebuild is required after setting them (true for the whole
AdSense integration).

### ads.txt

Served at the domain root by a Next.js route handler (`app/ads.txt/route.ts`,
mirrors how `app/robots.ts` is env-driven). When `NEXT_PUBLIC_ADSENSE_CLIENT_ID`
is set it emits the single standard line
`google.com, pub-XXXXXXXX, DIRECT, f08c47fec0942fa0` (the `ca-` prefix is stripped
to the bare `pub-...`; the trailing id is Google's fixed certification-authority
id). When unset it returns 404 (no file). After go-live, verify
`https://<domain>/ads.txt` shows exactly that line.

### Fallback chain (per slot)

```
1. First-party boost  (lib/connect/ads house registry / decide service)
2. Google AdSense     (GoogleAdUnit, when configured for the slot)
3. House self-promo    (HouseAdFallback -> /connect/boosts) when AdSense returns NO fill
4. Nothing             (AdSense not configured AND no house creative)
```

- `AdSlot` picks boost -> AdSense -> nothing (step 4) when AdSense is unconfigured.
- When AdSense IS configured but a specific impression returns no ad, the unit
  detects no-fill via the `<ins data-ad-status>` attribute (a `MutationObserver`
  on it plus a `NO_FILL_TIMEOUT_MS` backstop) and collapses to the house
  self-promo instead of leaving a void. The fallback reserves the **same**
  min-height as the unit, so the swap never shifts content.

### Layout stability (CLS)

Each `GoogleAdUnit` reserves a min-height floor before it fills
(`adReservedHeightClass` in `lib/connect/ads.ts`): rail = 250px (300px on `xl`),
grid = 280px. Floors, not fixed heights, so a taller responsive fill grows
downward (rails have nothing below them in the read). Units lazy-mount below the
fold via the established `IntersectionObserver` pattern: the paid
`adsbygoogle.push` only fires when the unit nears the viewport.

### Measurement

The `connect.ad.impression` analytics event (kind=`adsense`, placement only, no
campaignId) fires on **fill**, not on mount, aligned with the typed catalog
(`lib/analytics-events.ts`). No-fill fires no impression.

### Where AdSense can NEVER appear (confinement)

- The **loader script** is mounted in exactly one place: `app/connect/layout.tsx`
  via `AdSenseLoader` (env-gated). It is never mounted on ERP, marketing, kiosk,
  portal, or admin route trees, so `adsbygoogle` does not even exist there.
- `AdSlot` / `GoogleAdUnit` are only imported by Connect rail/grid components
  (`ConnectRightRail`, `EntityAdRail`, `MarketplaceGridAdCell`), all under
  `/connect/*` content pages. The inbox (`/connect/inbox`) renders no rail.
- Double guarantee: even if a unit were mounted off `/connect`, the loader would
  be absent there, so the push throws and the slot stays empty (no ad).

### Go-live checklist (owner)

1. [ ] Create / approve a Google AdSense account for the production domain.
2. [ ] Set `NEXT_PUBLIC_ADSENSE_CLIENT_ID` (`ca-pub-...`) in the web deploy env.
3. [ ] Create one ad unit per placement in AdSense; set each
       `NEXT_PUBLIC_ADSENSE_SLOT_*` to its slot id.
4. [ ] Deploy / rebuild the web app (these are build-time vars).
5. [ ] Verify `https://<domain>/ads.txt` returns the `google.com ... DIRECT ...`
       line; submit the site for AdSense review.
6. [ ] After approval, smoke each rail/grid: a filled unit shows "Sponsored"; an
       unfilled unit shows the "Advertise on Zari360" house card (not a blank).
7. [ ] TODO (defer): no Consent Management Platform (CMP) is wired - India-first
       launch. If EEA/UK traffic becomes material, add an IAB-TCF CMP for
       personalised-ads consent before serving those regions.
