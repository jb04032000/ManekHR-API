import { Body, Controller, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { SetAppLockIdleDto } from './dto/set-app-lock-idle.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
type AuthedRequest = Request & { user: { sub: string } };

/**
 * `/me/security` — per-user security preferences.
 *
 * Currently hosts the App Lock idle-timeout override. The per-workspace
 * `Workspace.appLockIdleMs` is the admin-set baseline; this is the user's
 * personal override (resolution: user → workspace → env default). For a
 * Connect-only (workspace-less) account this is the ONLY idle source.
 * `JwtAuthGuard` only — user-scoped.
 */
// @SkipPinUnlock: setting one's own App Lock idle-timeout is a product-neutral
// preference backing the shared `/account/security` area, and it is itself part
// of the App Lock config - so it cannot require being unlocked first. App Lock
// is ERP-only; this user-scoped surface must stay reachable without a PIN
// (Connect-only accounts have no PIN). Keep in sync with the web
// `appLockEnabled = mode === 'erp'` gate.
@SkipPinUnlock()
@LegacyUnclassified()
@Controller('me/security')
@UseGuards(JwtAuthGuard)
export class MeSecurityController {
  constructor(private readonly usersService: UsersService) {}

  /** Set or clear the caller's App Lock idle-timeout (`null` clears it). */
  @Patch('app-lock-idle')
  setAppLockIdle(@Req() req: AuthedRequest, @Body() dto: SetAppLockIdleDto) {
    return this.usersService.setAppLockIdleMs(req.user.sub, dto.appLockIdleMs);
  }
}
