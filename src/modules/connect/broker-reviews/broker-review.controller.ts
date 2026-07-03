import {
  Body,
  Controller,
  Get,
  Inject,
  Optional,
  Param,
  Post as HttpPost,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { AuthenticatedOnly } from '../../../common/decorators/require-permission.decorator';
import { AppModule } from '../../../common/enums/modules.enum';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { BrokerReviewService } from './broker-review.service';
import {
  BrokerReviewIdParam,
  ReplyBrokerReviewDto,
  UpsertBrokerReviewDto,
} from './dto/broker-review.dto';

/** JWT payload populated by JwtAuthGuard. `sub` is the caller's User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/connect/broker-reviews` — write + own-read broker-review endpoints
 * (verified-but-anonymous, anchored to a confirmed introduction).
 *
 * Mirrors `ReviewController` / `IntroductionController`: `JwtAuthGuard` +
 * `@AuthenticatedOnly()` (cross-workspace user-level writes; without the RBAC
 * marker the global fail-closed `RolesGuard` 403s every write), writes throttled
 * on the `connect-write` tier + audited (`workspaceId: null` — Connect is
 * tenant-agnostic) + emit an `@Optional()` PostHog `connect.broker_review_*` event.
 *
 * The actor is ALWAYS `req.user.sub` (never a body / param): the reviewer on
 * upsert / withdraw, the broker on reply. The party / subject gate lives in the
 * service. The public proof-led profile lives on `BrokerReviewPublicController`.
 */
@Controller('connect/broker-reviews')
@UseGuards(JwtAuthGuard)
@AuthenticatedOnly()
export class BrokerReviewController {
  constructor(
    private readonly brokerReviews: BrokerReviewService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /** Create or edit the caller's review of a broker (reviewer = the caller). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @HttpPost()
  async upsert(@Req() req: AuthedRequest, @Body() dto: UpsertBrokerReviewDto) {
    const review = await this.brokerReviews.upsertReview(req.user.sub, dto);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'BrokerReview',
      entityId: String(review._id),
      action: 'upsert',
      actorId: req.user.sub,
      meta: { introductionId: dto.introductionId, rating: dto.rating },
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.broker_review_submitted',
      properties: { introductionId: dto.introductionId, rating: dto.rating },
    });
    return review;
  }

  /** The broker posts their single reply to a review (broker = the caller). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @HttpPost(':id/reply')
  async reply(
    @Req() req: AuthedRequest,
    @Param() params: BrokerReviewIdParam,
    @Body() dto: ReplyBrokerReviewDto,
  ) {
    const review = await this.brokerReviews.replyToReview(req.user.sub, params.id, dto.text);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'BrokerReview',
      entityId: params.id,
      action: 'reply',
      actorId: req.user.sub,
      meta: {},
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.broker_review_replied',
      properties: { reviewId: params.id },
    });
    return review;
  }

  /** The original reviewer withdraws their review (soft-delete; reviewer = caller). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @HttpPost(':id/withdraw')
  async withdraw(@Req() req: AuthedRequest, @Param() params: BrokerReviewIdParam) {
    await this.brokerReviews.withdrawReview(req.user.sub, params.id);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'BrokerReview',
      entityId: params.id,
      action: 'withdraw',
      actorId: req.user.sub,
      meta: {},
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.broker_review_withdrawn',
      properties: { reviewId: params.id },
    });
    return { withdrawn: true };
  }

  /** The caller's own review for an introduction (drives the edit form), or null. */
  @Get('mine')
  getMine(@Req() req: AuthedRequest, @Query('introductionId') introductionId: string) {
    return this.brokerReviews.getMyReview(req.user.sub, introductionId);
  }
}

/**
 * `/connect/broker-reviews/public` — the unauthenticated proof-led broker profile
 * (aggregate + anonymized review cards). Leak-safe: never returns a reviewer id,
 * and never a name for an anonymous review.
 */
@Controller('connect/broker-reviews/public')
export class BrokerReviewPublicController {
  constructor(private readonly brokerReviews: BrokerReviewService) {}

  @Public()
  @Get('broker/:brokerUserId')
  getPublicBrokerProfile(@Param('brokerUserId') brokerUserId: string) {
    return this.brokerReviews.getPublicBrokerProfile(brokerUserId);
  }
}
