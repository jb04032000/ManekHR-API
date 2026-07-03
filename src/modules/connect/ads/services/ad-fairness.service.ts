import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../common/redis/redis.module';

/**
 * Platform fairness controls shared by EVERY ad placement (decision-service
 * step). Two independent Redis-backed mechanisms live here because both are
 * cheap counters/sets keyed by the viewer and only the decision service uses
 * them:
 *
 *   1. Daily campaign frequency cap (C4) - a viewer sees at most
 *      CAMPAIGN_DAILY_CAP impressions of the SAME campaign per calendar day.
 *      This is distinct from the per-ad-set cap in FrequencyCapService (which
 *      enforces the advertiser's own configured window/count); this one is the
 *      platform's "don't hammer the same person" guard across all placements.
 *
 *   2. Per-page dedupe (C5) - within one page response (rail + grid + feed on
 *      the same render), a campaign serves at most once. The page render passes
 *      a `pageRequestId`; every served campaign is recorded in a short-lived
 *      Redis set keyed by it, and the next slot on the same page excludes them.
 *
 * Cross-module link: bound to CAMPAIGN_CAP_REPO + PAGE_DEDUPE_REPO tokens in
 * ads.module.ts and injected into AdDecisionService. Viewer key is the JWT
 * userId (the /decide endpoint is JwtAuthGuard'd, so there is no anonymous
 * caller to key by - see ad-decision.service comment).
 */

/**
 * Max impressions of one campaign per viewer per calendar day. Constant by
 * product decision (fairness, not advertiser-configurable). Bump deliberately.
 */
export const CAMPAIGN_DAILY_CAP = 2;

/**
 * TTL for the daily-cap counter. The key already carries the UTC date, so it
 * rolls naturally at midnight; the TTL is just garbage collection set safely
 * past a single day (so a counter set at 23:59 still expires on its own).
 */
const CAMPAIGN_DAILY_TTL_SEC = 2 * 24 * 60 * 60;

/**
 * TTL for a page-dedupe set. A page's slots all resolve within a few seconds of
 * the same render; 120s comfortably covers SSR + client hydration straggle
 * without leaking memory if a page is abandoned.
 */
const PAGE_DEDUPE_TTL_SEC = 120;

/**
 * TTL for a viewer's "hide this sponsored post" suppression (Phase 7d). A reader
 * who hides an ad should stop seeing THAT campaign for a long stretch without us
 * keeping the row forever — 90 days comfortably outlasts a typical campaign
 * flight (the campaign usually ends first), and a re-hide refreshes it. Reuses
 * this Redis fairness store rather than a new collection (the feed-feedback spec
 * says to lean on the frequency-cap storage when it fits — a per-(viewer,
 * campaign) opt-out is exactly that shape).
 */
const AD_SUPPRESS_TTL_SEC = 90 * 24 * 60 * 60;

@Injectable()
export class AdFairnessService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // -------------------------------------------------------------------------
  // Daily campaign frequency cap (CampaignCapRepo)
  // -------------------------------------------------------------------------

  /** UTC calendar day stamp (YYYY-MM-DD) used in the daily-cap key. */
  private dayStamp(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private dailyKey(viewerKey: string, campaignId: string): string {
    return `adcap:day:${viewerKey}:${campaignId}:${this.dayStamp()}`;
  }

  /**
   * Read-only check: is the viewer still under the daily cap for this campaign?
   * Read-only (does NOT increment) so multiple candidates from the same campaign
   * in one auction, or losing candidates, never burn the cap - only an actual
   * served impression does (recordDailyCampaignServe, called on the winner).
   */
  async withinDailyCampaignCap(viewerKey: string, campaignId: string): Promise<boolean> {
    const n = Number(await this.redis.get(this.dailyKey(viewerKey, campaignId))) || 0;
    return n < CAMPAIGN_DAILY_CAP;
  }

  /**
   * Record one served impression toward the daily cap. Called ONLY on the
   * auction winner. Sets the TTL on first hit so the counter self-expires.
   */
  async recordDailyCampaignServe(viewerKey: string, campaignId: string): Promise<void> {
    const key = this.dailyKey(viewerKey, campaignId);
    const n = await this.redis.incr(key);
    if (n === 1) {
      await this.redis.expire(key, CAMPAIGN_DAILY_TTL_SEC);
    }
  }

  // -------------------------------------------------------------------------
  // Per-page dedupe (PageDedupeRepo)
  // -------------------------------------------------------------------------

  private pageKey(pageRequestId: string): string {
    return `adpage:${pageRequestId}`;
  }

  /** Campaign ids already served on this page render (empty set if none / no page). */
  async servedCampaigns(pageRequestId: string): Promise<string[]> {
    if (!pageRequestId) return [];
    return this.redis.smembers(this.pageKey(pageRequestId));
  }

  /** Record that a campaign served on this page so later slots can dedupe it. */
  async markServedOnPage(pageRequestId: string, campaignId: string): Promise<void> {
    if (!pageRequestId) return;
    const key = this.pageKey(pageRequestId);
    await this.redis.sadd(key, campaignId);
    // Refresh the TTL on every add so a page with several staggered slots keeps
    // the set alive for the whole render window.
    await this.redis.expire(key, PAGE_DEDUPE_TTL_SEC);
  }

  // -------------------------------------------------------------------------
  // Viewer "hide this sponsored post" suppression (Phase 7d — SuppressionRepo)
  // -------------------------------------------------------------------------

  private suppressKey(viewerKey: string, campaignId: string): string {
    return `adsuppress:${viewerKey}:${campaignId}`;
  }

  /**
   * Record that the viewer hid a sponsored post — that campaign stops serving to
   * THIS viewer (the ad-feedback equivalent of `not_interested` on a campaign).
   * Idempotent; a re-hide just refreshes the window.
   */
  async suppressCampaign(viewerKey: string, campaignId: string): Promise<void> {
    await this.redis.set(this.suppressKey(viewerKey, campaignId), '1', 'EX', AD_SUPPRESS_TTL_SEC);
  }

  /** Has the viewer hidden this campaign? The decision auction skips it if so. */
  async isCampaignSuppressed(viewerKey: string, campaignId: string): Promise<boolean> {
    return (await this.redis.exists(this.suppressKey(viewerKey, campaignId))) === 1;
  }
}
