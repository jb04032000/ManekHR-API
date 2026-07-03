import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { ConnectSearchThrottlerGuard } from '../search/connect-search-throttler.guard';
import { MentionSuggestService } from './mention-suggest.service';
import { SuggestQueryDto } from './dto/suggest.dto';

/** JWT payload shape populated by `JwtAuthGuard` -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/mention` -- the composer @-picker source. `GET /connect/mention/suggest?q=&scope=`
 * returns compact prefix suggestions across public people + company pages +
 * storefronts. Authed (`JwtAuthGuard`, mirroring the sibling search surface), and
 * reuses the per-user `ConnectSearchThrottlerGuard` + the `connect-search`
 * throttle tier because typing fires many calls. The service applies the SAME
 * public-visibility gates the federated search uses, so the picker never surfaces
 * something search would hide.
 */
@LegacyUnclassified()
@Controller('connect/mention')
@UseGuards(JwtAuthGuard)
export class MentionController {
  constructor(private readonly suggestService: MentionSuggestService) {}

  @Get('suggest')
  @UseGuards(ConnectSearchThrottlerGuard)
  @Throttle({ 'connect-search': { limit: 120, ttl: 60_000 } })
  async getSuggestions(@Req() req: AuthedRequest, @Query() dto: SuggestQueryDto) {
    return this.suggestService.suggest(req.user.sub, dto.q, dto.scope ?? 'all');
  }
}
