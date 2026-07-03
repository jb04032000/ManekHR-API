import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PostHogService } from '../../common/posthog/posthog.service';
import { UsersService } from './users.service';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` — `sub` is the User id. */
type AuthedRequest = Request & { user: { sub: string } };

/**
 * `/me/erp-*` — the caller's ERP policy-consent surface.
 *
 * The ERP mirror of `connect/profile`'s `entry` + `policy-accept` endpoints.
 * `JwtAuthGuard` only — user-scoped, not workspace-scoped. The accept emits a
 * PostHog event (mirrors Connect's `acceptPolicy`, which is PostHog-only —
 * policy acceptance is a user self-action, not an admin write, so it is not
 * AuditService-logged). See docs/connect/specs/2026-05-19-dual-policy-design.md.
 */
@LegacyUnclassified()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MePolicyController {
  constructor(
    private readonly usersService: UsersService,
    private readonly postHog: PostHogService,
  ) {}

  /** ERP policy-consent state — drives the ERP shell's server-side gate. */
  @Get('erp-entry')
  getErpEntry(@Req() req: AuthedRequest) {
    return this.usersService.getErpPolicyState(req.user.sub);
  }

  /** Record the caller's one-time ERP policy/terms acceptance. */
  @Post('erp-policy-accept')
  async acceptErpPolicy(@Req() req: AuthedRequest) {
    const res = await this.usersService.acceptErpPolicy(req.user.sub);
    this.postHog.capture({
      distinctId: req.user.sub,
      event: 'erp.policy_accepted',
      properties: {},
    });
    return res;
  }
}
