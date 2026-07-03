/**
 * ManekHR Connect -- traction-based boost-nudge tuning constants.
 *
 * What it does: holds every magic number the nudge engine uses (per-kind 7-day
 * view thresholds, the cool-down / dismissal windows, the candidate-scan cap,
 * and the campaign statuses that count as an in-flight boost). Centralised so
 * the owner can re-tune "what counts as traction" without hunting through the
 * service.
 *
 * Cross-module links: consumed by boost-nudge.service.ts. The view data these
 * thresholds compare against comes from THREE existing stores (no new tracking):
 *   - listing: connect_view_daily (ConnectViewService) -- per-viewer-per-DAY
 *     deduped counts, so 7d = unique viewer-days over the window.
 *   - post:    connectengagementedges type='view' (FeedService.recordViews) --
 *     one row per unique viewer (90d TTL), so 7d = unique NEW viewers in window.
 *   - job:     connect_job_views (JobsService) -- one row per unique viewer, so
 *     7d = unique NEW viewers in window.
 *
 * Watch: the three stores dedupe on different keys (listing per-day, post/job
 * per-viewer-lifetime), so a listing's 7d number and a post's 7d number are NOT
 * the same unit. Thresholds are therefore tuned PER KIND, not shared.
 */

import type { BoostNudgeKind } from './boost-nudge.types';

/** The rolling window (days) over which "traction" is measured for every kind. */
export const NUDGE_WINDOW_DAYS = 7;

/**
 * Minimum views in the last {@link NUDGE_WINDOW_DAYS} days for an entity to be
 * "demonstrably getting attention" and worth a nudge. No production view-volume
 * baseline exists yet (the marketplace is pre-launch), so these are sane,
 * deliberately conservative starting points -- high enough that the prompt only
 * fires on real traction, low enough that an early seller with a genuinely
 * popular item still sees it. Tune as real data arrives.
 *
 *  - listing (25): per-day-deduped, so 25 ~= a steady ~4 distinct viewers/day.
 *  - post (30): the feed has the widest organic reach, so the bar is highest.
 *  - job (15): jobs are the lowest-volume, most niche surface, so the bar is
 *    lowest -- 15 interested viewers on an open role is meaningful pull.
 */
export const NUDGE_VIEW_THRESHOLDS: Record<BoostNudgeKind, number> = {
  listing: 25,
  post: 30,
  job: 15,
};

/**
 * Once an owner has been SHOWN any nudge, suppress all nudges for this many days
 * (the global cool-down). Stored as a single per-owner row whose TTL equals this
 * window, so the row self-expires exactly when the cool-down lapses.
 */
export const NUDGE_SHOWN_COOLDOWN_DAYS = 7;

/**
 * A dismissal of a specific entity's nudge sticks for this many days. The
 * dismissal row's TTL equals this window, so it self-expires (the entity becomes
 * nudge-eligible again) once the period passes.
 */
export const NUDGE_DISMISS_DAYS = 30;

/** Max nudge candidates returned by the endpoint (ranked by views desc). */
export const NUDGE_MAX_CANDIDATES = 3;

/**
 * Per-kind cap on how many of the owner's most-recent entities we scan for
 * traction. A nudge needs views in the last 7 days, so only recent-ish entities
 * can ever qualify; scanning the newest N (createdAt desc) bounds the work for a
 * prolific owner. Surfaced in the feature report -- not a silent truncation.
 */
export const NUDGE_SCAN_LIMIT = 100;

/**
 * Campaign statuses that mean "this entity already has an in-flight boost" and
 * must NOT be nudged. Mirrors the BoostService create-path guard exactly
 * (pending_review / active / paused block a re-boost; completed / rejected /
 * expired do not). Keep in sync with boost.service.ts.
 */
export const ACTIVE_BOOST_STATUSES = ['pending_review', 'active', 'paused'] as const;

/** Campaign kinds whose source refs we read to find already-boosted entities. */
export const BOOST_CAMPAIGN_KINDS = ['boost_listing', 'boost_job', 'boost_post'] as const;

/** Max characters of a post body used as its human-readable nudge name. */
export const POST_NAME_MAX = 60;
