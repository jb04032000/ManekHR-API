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
import { AuthenticatedOnly } from '../../../common/decorators/require-permission.decorator';
import { AppModule } from '../../../common/enums/modules.enum';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { IntroductionService } from './introduction.service';
import { CreateIntroductionDto, IntroductionIdParam } from './dto/introduction.dto';
import type { IntroductionStatus } from './schemas/introduction.schema';

/** JWT payload populated by JwtAuthGuard. `sub` is the caller's User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/connect/introductions` — broker-mediated introductions (anti-gaming core).
 *
 * Mirrors `ReviewController`: `JwtAuthGuard` + `@AuthenticatedOnly()` (these are
 * cross-workspace user-level writes; without the RBAC marker the global
 * fail-closed `RolesGuard` 403s every write), writes are throttled on the
 * `connect-write` tier + audited (`workspaceId: null` — Connect is
 * tenant-agnostic) + emit an `@Optional()` PostHog `connect.<verb>_noun` event.
 *
 * The actor is ALWAYS `req.user.sub` (never a body / param) for confirm + decline,
 * so cross-user action is impossible (the party gate lives in the service).
 */
@Controller('connect/introductions')
@UseGuards(JwtAuthGuard)
@AuthenticatedOnly()
export class IntroductionController {
  constructor(
    private readonly introductions: IntroductionService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /** Create a pending introduction (broker = the caller). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @HttpPost()
  async create(@Req() req: AuthedRequest, @Body() dto: CreateIntroductionDto) {
    const intro = await this.introductions.create(req.user.sub, dto);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Introduction',
      entityId: String(intro._id),
      action: 'create',
      actorId: req.user.sub,
      meta: {
        partyAUserId: dto.partyAUserId,
        partyBUserId: dto.partyBUserId,
        roleOfA: dto.roleOfA,
      },
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.introduction_created',
      properties: { introductionId: String(intro._id) },
    });
    return intro;
  }

  /** Confirm the caller's own side of an introduction. */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  @HttpPost(':id/confirm')
  async confirm(@Req() req: AuthedRequest, @Param() params: IntroductionIdParam) {
    const intro = await this.introductions.confirm(params.id, req.user.sub);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Introduction',
      entityId: params.id,
      action: 'confirm',
      actorId: req.user.sub,
      meta: { status: intro.status },
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.introduction_confirmed',
      properties: { introductionId: params.id },
    });
    return intro;
  }

  /** Decline the caller's participation (soft-delete). */
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  @HttpPost(':id/decline')
  async decline(@Req() req: AuthedRequest, @Param() params: IntroductionIdParam) {
    const intro = await this.introductions.decline(params.id, req.user.sub);
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Introduction',
      entityId: params.id,
      action: 'decline',
      actorId: req.user.sub,
      meta: {},
    });
    this.posthog?.capture({
      distinctId: req.user.sub,
      event: 'connect.introduction_declined',
      properties: { introductionId: params.id },
    });
    return intro;
  }

  /** The caller's pending-to-confirm queue. */
  @Get('pending')
  pending(@Req() req: AuthedRequest) {
    return this.introductions.listPendingForUser(req.user.sub);
  }

  /** The caller's introductions as a broker (their auto contact book). */
  @Get('mine')
  mine(@Req() req: AuthedRequest, @Query('status') status?: IntroductionStatus) {
    return this.introductions.listForBroker(req.user.sub, status);
  }

  /**
   * The introductions the caller RECEIVED (as a party) so they can review the
   * broker. Defaults to confirmed; pass `?status=` to widen.
   */
  @Get('received')
  received(@Req() req: AuthedRequest, @Query('status') status?: IntroductionStatus) {
    return this.introductions.listReceivedForUser(req.user.sub, status);
  }
}
