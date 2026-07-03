import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { DismissHintDto } from './dto/dismiss-hint.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
type AuthedRequest = Request & { user: { sub: string } };

/**
 * `/me/dismiss-hint` — the caller's dismissible-UI-hint preferences.
 *
 * A dismissed hint (e.g. the Connect explore nudge) is recorded on
 * `User.dismissedHints` so it stays dismissed across sign-out and devices.
 * localStorage did neither — it is wiped by `localStorage.clear()` on every
 * dead-session / sign-out path. `JwtAuthGuard` only — user-scoped.
 */
@LegacyUnclassified()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MePrefsController {
  constructor(private readonly usersService: UsersService) {}

  /** Record that the caller dismissed a UI hint (idempotent). */
  @Post('dismiss-hint')
  dismissHint(@Req() req: AuthedRequest, @Body() dto: DismissHintDto) {
    return this.usersService.dismissHint(req.user.sub, dto.hint);
  }
}
