import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { ConnectViewService } from '../services/connect-view.service';
import { RecordViewDto } from '../dto/record-view.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/views` -- record storefront / product views + read a storefront's
 * view analytics. The viewer is always the authenticated user (`req.user.sub`).
 * Analytics are owner-scoped in the service.
 */
@LegacyUnclassified()
@Controller('connect/views')
@UseGuards(JwtAuthGuard)
export class ConnectViewController {
  constructor(private readonly views: ConnectViewService) {}

  /** Record one view (deduped per viewer per day). High-frequency, lenient tier. */
  @Post()
  @Throttle({ 'connect-view': { limit: 120, ttl: 60_000 } })
  record(@Req() req: AuthedRequest, @Body() dto: RecordViewDto) {
    return this.views.recordView(req.user.sub, dto.targetType, dto.targetId);
  }

  /** A storefront's view roll-up (7d / 30d / 30-day series + per-listing 7d). */
  @Get('storefront/:storefrontId/summary')
  storefrontSummary(@Req() req: AuthedRequest, @Param('storefrontId') storefrontId: string) {
    return this.views.storefrontSummary(req.user.sub, storefrontId);
  }

  /** The caller own profile-view totals (header stat). Self-scoped only. */
  @Get('profile/summary')
  profileSummary(@Req() req: AuthedRequest) {
    return this.views.profileViewSummary(req.user.sub);
  }
}
