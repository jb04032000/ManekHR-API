import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { BoostService } from '../services/boost.service';
import { CreateListingBoostDto } from '../dto/create-listing-boost.dto';
import { CreateJobBoostDto } from '../dto/create-job-boost.dto';
import { CreatePostBoostDto } from '../dto/create-post-boost.dto';
import { CreateOpenToWorkBoostDto } from '../dto/create-open-to-work-boost.dto';
import { CreateHiringBoostDto } from '../dto/create-hiring-boost.dto';
import { CreateRfqBoostDto } from '../dto/create-rfq-boost.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/ads/boosts` -- boost campaign management for the authed user.
 *
 * The advertiser is always the authenticated Connect User (`req.user.sub`).
 * ownerUserId is never accepted from the request body -- it is always derived
 * from the JWT so cross-user manipulation is impossible.
 */
// CN-ADS-5 (Bucket 4): ThrottlerGuard in the class chain so the per-method
// ads-boost-create @Throttle tiers actually enforce.
@LegacyUnclassified()
@Controller('connect/ads/boosts')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class BoostController {
  constructor(private readonly boostService: BoostService) {}

  /**
   * Boost one of the caller's marketplace listings (M2.1). The listing must be
   * owned by the caller and approved; both are enforced in the service. Budget
   * is reserved atomically from the caller's wallet (grant credits first).
   */
  @Post('listing')
  @Throttle({ 'ads-boost-create': { limit: 20, ttl: 60_000 } })
  createListing(@Req() req: AuthedRequest, @Body() dto: CreateListingBoostDto) {
    return this.boostService.createListingBoost({
      ownerUserId: req.user.sub,
      listingId: dto.listingId,
      objective: dto.objective,
      totalBudget: dto.totalBudget,
      days: dto.days,
      targeting: dto.targeting ?? {},
      spotlight: dto.spotlight,
    });
  }

  /**
   * Boost one of the caller's jobs (Phase 5). The job must be owned by the
   * caller and `open`; both are enforced in the service. Budget is reserved
   * atomically from the caller's wallet (grant credits first).
   */
  @Post('job')
  @Throttle({ 'ads-boost-create': { limit: 20, ttl: 60_000 } })
  createJob(@Req() req: AuthedRequest, @Body() dto: CreateJobBoostDto) {
    return this.boostService.createJobBoost({
      ownerUserId: req.user.sub,
      jobId: dto.jobId,
      objective: dto.objective,
      totalBudget: dto.totalBudget,
      days: dto.days,
      targeting: dto.targeting ?? {},
      spotlight: dto.spotlight,
    });
  }

  /**
   * Boost one of the caller's own feed posts. The post must be authored by the
   * caller, live, and `public` (all enforced in the service). Binds to the live
   * `feed_promoted_post` slot, so once approved it serves in others' feeds via
   * the existing decision + render path. Budget is reserved atomically from the
   * caller's wallet (grant credits first).
   */
  @Post('post')
  @Throttle({ 'ads-boost-create': { limit: 20, ttl: 60_000 } })
  createPost(@Req() req: AuthedRequest, @Body() dto: CreatePostBoostDto) {
    return this.boostService.createPostBoost({
      ownerUserId: req.user.sub,
      postId: dto.postId,
      objective: dto.objective,
      totalBudget: dto.totalBudget,
      days: dto.days,
      targeting: dto.targeting ?? {},
      spotlight: dto.spotlight,
    });
  }

  /**
   * Boost the caller's own profile as "open to work" (reaches employers). The
   * caller's `openTo.work` must be on (enforced in the service). Budget is reserved
   * atomically from the caller's wallet (grant credits first).
   */
  @Post('open-to-work')
  @Throttle({ 'ads-boost-create': { limit: 20, ttl: 60_000 } })
  createOpenToWork(@Req() req: AuthedRequest, @Body() dto: CreateOpenToWorkBoostDto) {
    return this.boostService.createOpenToWorkBoost({
      ownerUserId: req.user.sub,
      objective: dto.objective,
      totalBudget: dto.totalBudget,
      days: dto.days,
      targeting: dto.targeting ?? {},
      spotlight: dto.spotlight,
    });
  }

  /**
   * Boost the caller's own "hiring" status (reaches workers). Profile/intent level,
   * no specific job post required. The caller's `openTo.hiring` must be on (enforced
   * in the service). Budget is reserved atomically from the caller's wallet.
   */
  @Post('hiring')
  @Throttle({ 'ads-boost-create': { limit: 20, ttl: 60_000 } })
  createHiring(@Req() req: AuthedRequest, @Body() dto: CreateHiringBoostDto) {
    return this.boostService.createHiringBoost({
      ownerUserId: req.user.sub,
      objective: dto.objective,
      totalBudget: dto.totalBudget,
      days: dto.days,
      targeting: dto.targeting ?? {},
      spotlight: dto.spotlight,
    });
  }

  /**
   * Boost one of the caller's open RFQs (reaches suppliers). The RFQ must be owned
   * by the caller and `open` (both enforced in the service). Budget is reserved
   * atomically from the caller's wallet (grant credits first).
   */
  @Post('rfq')
  @Throttle({ 'ads-boost-create': { limit: 20, ttl: 60_000 } })
  createRfq(@Req() req: AuthedRequest, @Body() dto: CreateRfqBoostDto) {
    return this.boostService.createRfqBoost({
      ownerUserId: req.user.sub,
      rfqId: dto.rfqId,
      objective: dto.objective,
      totalBudget: dto.totalBudget,
      days: dto.days,
      targeting: dto.targeting ?? {},
      spotlight: dto.spotlight,
    });
  }

  /**
   * List every campaign owned by the caller (newest first), each with REAL
   * lifetime metrics (impressions / clicks / spend + ctr + costPerClick) from
   * `ad_daily_rollups`. All statuses are returned; the web tabs them client-side.
   */
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.boostService.list(req.user.sub);
  }

  /**
   * KPI aggregates for the caller (activeCount, reach30d, clicks30d,
   * spendThisMonth). Declared before `@Get(':id')` so the literal `stats`
   * segment is not captured by the `:id` route parameter.
   */
  @Get('stats')
  stats(@Req() req: AuthedRequest) {
    return this.boostService.stats(req.user.sub);
  }

  /**
   * The caller's quick-start "boost something" candidates: their own listings +
   * jobs that are eligible to boost right now (status gate mirrors the create
   * gates) + their active profile intents. Powers the web Boosts-hub quick-start.
   * Declared before `@Get(':id')` so the literal `boostable` segment is not
   * captured by the `:id` route parameter (same reason as `stats`).
   */
  @Get('boostable')
  boostable(@Req() req: AuthedRequest) {
    return this.boostService.boostable(req.user.sub);
  }

  /** Get live status + metrics for one of the caller's boost campaigns. */
  @Get(':id')
  getStatus(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.boostService.status(id, req.user.sub);
  }

  // BOOST-USER-CONTROLS-OFF (owner 2026-06-19): users can't pause/resume/cancel + spend hidden from users; admin keeps control. Commented (not deleted) to re-enable later.
  // The three user-facing caller routes below let a user pause / resume / cancel
  // their own live boost. They are disabled so only an admin controls a live boost
  // (admin take-down is a separate path in ads-admin, left untouched). The
  // boostService.pause/resume/cancel methods stay intact (now dormant) so these
  // routes can be switched back on as-is. Cross-module: ads.actions.ts also
  // disables pauseBoost/resumeBoost/cancelBoost; the Boosts manager + results card
  // render read-only (status + days-left only).
  //
  // /** Pause one of the caller's live boost campaigns. */
  // @Post(':id/pause')
  // pause(@Req() req: AuthedRequest, @Param('id') id: string) {
  //   return this.boostService.pause(id, req.user.sub);
  // }
  //
  // /** Resume one of the caller's paused boost campaigns. */
  // @Post(':id/resume')
  // resume(@Req() req: AuthedRequest, @Param('id') id: string) {
  //   return this.boostService.resume(id, req.user.sub);
  // }
  //
  // /** Cancel one of the caller's boost campaigns (refunds unused budget). */
  // @Post(':id/cancel')
  // cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
  //   return this.boostService.cancel(id, req.user.sub);
  // }
}
