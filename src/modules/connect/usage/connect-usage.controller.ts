import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { ConnectUsageService, ConnectUsageRow } from './connect-usage.service';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `GET /me/connect/usage` — the caller's live usage vs limit for every Connect
 * count cap plus storage. Read-only; `JwtAuthGuard` only (Connect is flag-gated,
 * not subscription-gated), mirroring the `me/connect/profile` controller.
 *
 * Returns `{ kind, used, limit }[]`; `limit === -1` = unlimited. The web app
 * uses this to render usage meters and to pre-empt a blocked create.
 */
@LegacyUnclassified()
@Controller('me/connect/usage')
@UseGuards(JwtAuthGuard)
export class ConnectUsageController {
  constructor(private readonly usage: ConnectUsageService) {}

  @Get()
  get(@Req() req: AuthedRequest): Promise<ConnectUsageRow[]> {
    return this.usage.getUsageForUser(req.user.sub);
  }
}
