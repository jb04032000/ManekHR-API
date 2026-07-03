import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { AdDecisionService } from '../services/ad-decision.service';
import { AdEventsService } from '../services/ad-events.service';
import { AdFairnessService } from '../services/ad-fairness.service';
import { DecideDto } from '../dto/decide.dto';
import { RecordEventDto } from '../dto/record-event.dto';
import { HideAdDto } from '../dto/hide-ad.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
  /** Raw request headers -- the user-agent feeds the click IVT bot heuristic. */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * `connect/ads` -- ad decision and event recording.
 *
 * `POST /decide` is called by the feed renderer (SSR or client) to pick the
 * winning ad for a placement slot. `POST /events/*` are called by the client
 * viewability and click beacons.
 *
 * userId is always taken from the JWT (`req.user.sub`) so events cannot be
 * fabricated on behalf of another user.
 */
// CN-ADS-5 (Bucket 4): ThrottlerGuard is added to the class guard chain so every
// method's @Throttle actually enforces (the global APP_GUARD list has no
// ThrottlerGuard, so a bare @Throttle without this guard was purely decorative).
// Class-level also covers any future method that forgets its own guard — a route
// with no @Throttle still falls back to the ThrottlerModule.forRoot() default,
// strictly safer than the previous "no limit at all."
@LegacyUnclassified()
@Controller('connect/ads')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class DecideController {
  constructor(
    private readonly adDecisionService: AdDecisionService,
    private readonly adEventsService: AdEventsService,
    private readonly adFairnessService: AdFairnessService,
  ) {}

  /** Run the ad auction for a placement slot and return the winning ad token.
   *  CN-ADS-5: the highest-frequency Connect request had NO throttle. 300/min
   *  (~5/sec sustained) is generous — a feed page fires one /decide per ad slot
   *  and may have several slots — while still bounding abuse. Sized above the
   *  connect-engage (90) tier since a single page legitimately makes several. */
  @Throttle({ 'ads-decide': { limit: 300, ttl: 60_000 } })
  @Post('decide')
  decide(@Req() req: AuthedRequest, @Body() dto: DecideDto) {
    return this.adDecisionService.decide({
      userId: req.user.sub,
      placementKey: dto.placementKey,
      // Threaded through for per-page dedupe (fairness C5); undefined when the
      // caller is a single-slot page that did not generate a page id.
      pageRequestId: dto.pageRequestId,
      // CN-ADS-8: restrict the auction to specific creative kinds (profile-only
      // for the network page's promoted-profile slot).
      kinds: dto.kinds,
    });
  }

  /**
   * Record a viewability beacon (CPM charge or CPC mark-viewable).
   * Idempotent -- duplicate tokens are no-ops.
   * Returns 204 No Content.
   */
  @Post('events/impression')
  @HttpCode(204)
  @Throttle({ 'ads-event-impression': { limit: 120, ttl: 60_000 } })
  async recordImpression(@Req() req: AuthedRequest, @Body() dto: RecordEventDto) {
    // CN-ADS-11: thread the caller so the service can reject a leaked/replayed
    // token fired by anyone other than the viewer it was served to.
    await this.adEventsService.recordImpression(dto.impressionToken, req.user.sub);
  }

  /**
   * Record a click event (CPC charge).
   * Idempotent -- one charge per impression token.
   * Returns 204 No Content.
   */
  @Post('events/click')
  @HttpCode(204)
  @Throttle({ 'ads-event-click': { limit: 120, ttl: 60_000 } })
  async recordClick(@Req() req: AuthedRequest, @Body() dto: RecordEventDto) {
    // user-agent header drives the IVT bot-UA heuristic (ads/lib/ivt.ts). A header
    // may arrive as string | string[]; normalize to the first value or undefined.
    const uaHeader = req.headers?.['user-agent'];
    const userAgent = Array.isArray(uaHeader) ? uaHeader[0] : uaHeader;
    await this.adEventsService.recordClick(dto.impressionToken, req.user.sub, userAgent);
  }

  /**
   * Hide a sponsored post (Phase 7d). Records a per-(viewer, campaign) suppression
   * so that campaign stops serving to this viewer — the ad-side equivalent of feed
   * `not_interested`. Idempotent; throttled on the impression tier. 204 No Content.
   */
  @Post('hide')
  @HttpCode(204)
  @Throttle({ 'ads-event-impression': { limit: 120, ttl: 60_000 } })
  async hide(@Req() req: AuthedRequest, @Body() dto: HideAdDto) {
    await this.adFairnessService.suppressCampaign(req.user.sub, dto.campaignId);
  }
}
