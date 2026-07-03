import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { AuditService } from '../audit/audit.service';
import { PostHogService } from '../../common/posthog/posthog.service';
import { UsersService, type HandleAvailability } from './users.service';
import { ClaimHandleDto } from './dto/claim-handle.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
type AuthedRequest = Request & { user: { sub: string } };

/**
 * `/me/profile/handle/*` — the caller's username-slug ("handle") surface.
 *
 * Two endpoints back the `/account/profile` HandleEditor:
 *  - `GET .../available?value=…` — debounced availability check used while
 *    the user types. Cheap-format-check + case-insensitive uniqueness lookup,
 *    excluding the caller themselves (so re-saving an existing value is not
 *    "taken").
 *  - `PATCH .../` — claim the handle. The service enforces format /
 *    reserved-list / case-insensitive uniqueness / 30-day cooldown and stamps
 *    `handleChangedAt`. Errors arrive as discriminated `{ code }` payloads
 *    (`HANDLE_INVALID_FORMAT`, `HANDLE_RESERVED`, `HANDLE_TAKEN`,
 *    `HANDLE_COOLDOWN`) so the client renders the matching inline copy.
 *
 * `JwtAuthGuard` only — user-scoped, not workspace-scoped (mirrors
 * `MePolicyController`, `MeSecurityController`).
 */
@LegacyUnclassified()
@Controller('me/profile')
@UseGuards(JwtAuthGuard)
export class MeProfileController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Debounced availability check for the HandleEditor. The discriminated
   * union mirrors the service so the client can render targeted error copy
   * (`format` vs `reserved` vs `taken`) without an extra round-trip.
   */
  @Get('handle/available')
  checkHandle(
    @Req() req: AuthedRequest,
    @Query('value') value: string,
  ): Promise<HandleAvailability> {
    return this.usersService.isHandleAvailable(value ?? '', req.user.sub);
  }

  /** Claim or change the caller's handle. */
  @Patch('handle')
  async claimHandle(@Req() req: AuthedRequest, @Body() dto: ClaimHandleDto) {
    const res = await this.usersService.claimHandle(req.user.sub, dto.handle);
    await this.auditService.logEvent({
      workspaceId: null, // identity-layer event — no workspace scope
      module: AppModule.AUTH,
      entityType: 'User',
      entityId: req.user.sub,
      action: 'update',
      actorId: req.user.sub,
      meta: { handle: res.handle },
    });
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'auth.handle_claimed',
      properties: { handle: res.handle },
    });
    return res;
  }
}
