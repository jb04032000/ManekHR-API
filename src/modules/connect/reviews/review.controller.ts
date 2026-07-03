import {
  Body,
  Controller,
  Delete,
  Get,
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
import { Inject, Optional } from '@nestjs/common';
import { ReviewService } from './review.service';
import { UpsertReviewDto } from './dto/review.dto';

interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/connect/reviews` — write + own-read review endpoints (marketplace Phase C).
 * `JwtAuthGuard`; writes are audited + emit a PostHog event + throttled. The
 * public seller-reviews list lives on `ReviewPublicController`.
 *
 * RBAC: reviewing is open to any signed-in member (no workspace permission),
 * so the class carries `@AuthenticatedOnly()`. Without an RBAC marker the
 * global fail-closed `RolesGuard` denies every write with 403 (the public
 * `@Public()` list still loads, which is why the Reviews tab renders but
 * submitting a review 403s). Keep this marker in sync with `RolesGuard`.
 */
@Controller('connect/reviews')
@UseGuards(JwtAuthGuard)
@AuthenticatedOnly()
export class ReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /** Create or edit the caller's review of a seller. */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @HttpPost()
  async upsert(@Req() req: AuthedRequest, @Body() dto: UpsertReviewDto) {
    const review = await this.reviews.upsert(req.user.sub, dto);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Review',
      entityId: String(review._id),
      action: 'upsert',
      actorId: req.user.sub,
      meta: { subjectUserId: dto.subjectUserId, rating: dto.rating },
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.review_submitted',
      properties: { subjectUserId: dto.subjectUserId, rating: dto.rating },
    });
    return review;
  }

  /** The caller's own review of a seller (drives the edit form), or null. */
  @Get('me/:subjectUserId')
  getMine(@Req() req: AuthedRequest, @Param('subjectUserId') subjectUserId: string) {
    return this.reviews.getMine(req.user.sub, subjectUserId);
  }

  /** Delete the caller's review of a seller. */
  @Delete(':subjectUserId')
  async remove(@Req() req: AuthedRequest, @Param('subjectUserId') subjectUserId: string) {
    await this.reviews.remove(req.user.sub, subjectUserId);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Review',
      entityId: subjectUserId,
      action: 'delete',
      actorId: req.user.sub,
      meta: {},
    });
    return { deleted: true };
  }

  /** Report a review for abuse. */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @HttpPost(':reviewId/report')
  async report(@Req() req: AuthedRequest, @Param('reviewId') reviewId: string) {
    await this.reviews.report(reviewId);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Review',
      entityId: reviewId,
      action: 'report',
      actorId: req.user.sub,
      meta: {},
    });
    return { ok: true };
  }
}

/**
 * `/connect/reviews/public` — the unauthenticated seller-reviews list + aggregate
 * (powers the public profile / company page Reviews tab).
 */
@Controller('connect/reviews/public')
export class ReviewPublicController {
  constructor(private readonly reviews: ReviewService) {}

  @Public()
  @Get('seller/:subjectUserId')
  listForSeller(@Param('subjectUserId') subjectUserId: string, @Query('cursor') cursor?: string) {
    return this.reviews.listForSeller(subjectUserId, cursor);
  }
}
