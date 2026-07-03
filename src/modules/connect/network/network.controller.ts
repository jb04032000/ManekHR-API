import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { AppModule } from '../../../common/enums/modules.enum';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { NetworkService } from './network.service';
import { SuggestionService } from './suggestion.service';
import { LIST_HARD_CAP } from '../common/keyset-cursor';
import {
  ListInvitationsQueryDto,
  RespondConnectionRequestDto,
  SendConnectionRequestDto,
} from './dto/network.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/me/connect/network` — the caller's professional graph (Phase 2 — Network).
 *
 * `JwtAuthGuard` only — Connect is feature-flagged, NOT subscription-gated
 * (mirrors `ConnectProfileController`). Every write is audited and emits a
 * PostHog event. Connection requests are person-to-person — a distinct domain
 * from the ERP `WorkspaceMember` invitation.
 */
@LegacyUnclassified()
@Controller('me/connect/network')
@UseGuards(JwtAuthGuard)
export class NetworkController {
  constructor(
    private readonly networkService: NetworkService,
    private readonly suggestionService: SuggestionService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  // ── Connection requests ────────────────────────────────────────────────

  /** Send a connection request to another member. */
  @Post('requests')
  async sendRequest(@Req() req: AuthedRequest, @Body() dto: SendConnectionRequestDto) {
    const created = await this.networkService.sendRequest(req.user.sub, dto.toUserId, dto.note);
    await this.auditService.logEvent({
      workspaceId: null, // identity-layer event — no workspace scope
      module: AppModule.CONNECT,
      entityType: 'ConnectionRequest',
      entityId: String(created._id),
      action: 'create',
      actorId: req.user.sub,
      meta: { toUserId: dto.toUserId },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.connection_requested',
      properties: { toUserId: dto.toUserId, withNote: Boolean(dto.note?.trim()) },
    });
    return created;
  }

  /** Accept or ignore a pending connection request (recipient only). */
  @Patch('requests/:id')
  async respondToRequest(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: RespondConnectionRequestDto,
  ) {
    const updated = await this.networkService.respondToRequest(req.user.sub, id, dto.action);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'ConnectionRequest',
      entityId: String(updated._id),
      action: 'update',
      actorId: req.user.sub,
      meta: { action: dto.action },
    });
    if (dto.action === 'accept') {
      this.postHog.capture({
        distinctId: req.user.sub,
        event: 'connect.connection_accepted',
        properties: { requestId: id },
      });
    }
    return updated;
  }

  /** Withdraw a pending connection request (sender only). */
  @Delete('requests/:id')
  async withdrawRequest(@Req() req: AuthedRequest, @Param('id') id: string) {
    const updated = await this.networkService.withdrawRequest(req.user.sub, id);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'ConnectionRequest',
      entityId: String(updated._id),
      action: 'update',
      actorId: req.user.sub,
      meta: { action: 'withdraw' },
    });
    return updated;
  }

  /** The caller's invitations — `?box=received|sent|archive` (default received). */
  @Get('invitations')
  listInvitations(@Req() req: AuthedRequest, @Query() query: ListInvitationsQueryDto) {
    return this.networkService.listInvitations(req.user.sub, query.box);
  }

  // ── Connections ────────────────────────────────────────────────────────

  /** The caller's connections (bounded for the HTTP read; the accurate total is
   *  on `/counts`). */
  @Get('connections')
  listConnections(@Req() req: AuthedRequest) {
    return this.networkService.listConnections(req.user.sub, { limit: LIST_HARD_CAP });
  }

  /** Remove a connection with another member. */
  @Delete('connections/:userId')
  async removeConnection(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    await this.networkService.removeConnection(req.user.sub, userId);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Connection',
      entityId: userId,
      action: 'delete',
      actorId: req.user.sub,
      meta: { otherUserId: userId },
    });
    return { removed: true };
  }

  // ── Follows ────────────────────────────────────────────────────────────

  /** Follow another member (asymmetric, idempotent). */
  @Post('following/:userId')
  async followUser(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    const follow = await this.networkService.followUser(req.user.sub, userId);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Follow',
      entityId: String(follow._id),
      action: 'create',
      actorId: req.user.sub,
      meta: { followeeType: 'user', followeeId: userId },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'connect.followed',
      properties: { followeeType: 'user', followeeId: userId },
    });
    return follow;
  }

  /** Unfollow a member. */
  @Delete('following/:userId')
  async unfollowUser(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    await this.networkService.unfollowUser(req.user.sub, userId);
    await this.auditService.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'Follow',
      entityId: userId,
      action: 'delete',
      actorId: req.user.sub,
      meta: { followeeType: 'user', followeeId: userId },
    });
    return { unfollowed: true };
  }

  /** Everything the caller follows (bounded for the HTTP read). */
  @Get('following')
  listFollowing(@Req() req: AuthedRequest) {
    return this.networkService.listFollowing(req.user.sub, { limit: LIST_HARD_CAP });
  }

  /** Everyone who follows the caller. */
  @Get('followers')
  listFollowers(@Req() req: AuthedRequest) {
    return this.networkService.listFollowers(req.user.sub);
  }

  // ── Counts ─────────────────────────────────────────────────────────────

  /** Network badge counts for the caller (pending requests / connections / following). */
  @Get('counts')
  getCounts(@Req() req: AuthedRequest) {
    return this.networkService.getCounts(req.user.sub);
  }

  // ── Suggestions ────────────────────────────────────────────────────────

  /** ERP-weighted "people you may know" for the caller. Read-only — OTel only. */
  @Get('suggestions')
  getSuggestions(@Req() req: AuthedRequest) {
    return this.suggestionService.getSuggestions(req.user.sub);
  }

  // ── Relationship ───────────────────────────────────────────────────────

  /**
   * The caller's relationship to another user — drives the Connect / Follow
   * buttons on `/u/[userId]`. `{ connected, incomingRequest, outgoingRequest,
   * following, self }`. Read-only.
   */
  @Get('relationship/:userId')
  getRelationship(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    return this.networkService.getRelationship(req.user.sub, userId);
  }
}

/**
 * `/connect/network/:userId/counts` — PUBLIC social-proof counts
 * (`{ connections, followers }`) for a profile header. Unauthenticated: these
 * numbers render on the logged-out public profile (`/u/[slug]`) as social
 * proof. Independent edge counts (see `NetworkService.getPublicProfileCounts`).
 * Takes a `User` ObjectId (the caller already resolved the profile, so it holds
 * `userId`) — not a handle.
 */
@Controller('connect/network')
export class ConnectNetworkPublicController {
  constructor(private readonly networkService: NetworkService) {}

  @Public()
  @Get(':userId/counts')
  getPublicCounts(@Param('userId') userId: string) {
    return this.networkService.getPublicProfileCounts(userId);
  }
}
