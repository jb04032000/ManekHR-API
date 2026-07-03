import { Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { WorkspacesService } from './workspaces.service';
import { AuthenticatedOnly } from '../../common/decorators/require-permission.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';

/**
 * Wave 2 W2.6 — pending-invites endpoint for the calling user. Returns
 * invites across all workspaces; powers the workspace-switcher badge.
 * User-scoped (not workspace-scoped) so it lives at /me, not /workspaces/:id.
 *
 * SEC-5 (Workspaces hardening AC-2.1) — class-level `@LegacyUnclassified` debt
 * removed. Every route is user-self (keyed on req.user.sub) with no workspace
 * context, so each is marked `@AuthenticatedOnly`. The global RolesGuard is
 * deny-by-default; an unmarked route would fail closed.
 *
 * App-Lock exempt (`@SkipPinUnlock`, 2026-06-20). App Lock (Quick PIN) is an
 * ERP-only protection for sensitive payroll/finance/staff surfaces. These
 * routes are identity-layer (user-self, no workspace payroll data) and are
 * called from OUTSIDE the ERP shell — the Connect switcher pending-invites
 * badge and the `/auth/setup-workspace` screen. A Connect-only user never sets
 * a PIN, so without this exemption `GET /me/invites/pending` returned 423
 * APP_LOCKED once the 5-min setup-grace expired; the web axios interceptor
 * parks 423s indefinitely, leaving setup-workspace hung on `invites === null`
 * (blank page). Mirrors the isConnectRequest / isAccountSelfServiceRequest
 * exemptions in common/guards/pin-unlock.guard.ts — keep FE + BE in sync.
 */
@Controller('me/invites')
@UseGuards(JwtAuthGuard)
@SkipPinUnlock()
export class MyInvitesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get('pending')
  @AuthenticatedOnly()
  pending(@Req() req: { user: { sub: string } }) {
    return this.workspacesService.getPendingInvitesForUser(req.user.sub);
  }

  /**
   * P2.0 (2026-05-15) — Sent tab on /dashboard/invitations. Returns every
   * invite the caller has personally sent across all workspaces, including
   * accepted / declined / removed / expired lifecycle states so the FE can
   * render status badges + per-row Resend / Cancel actions.
   */
  @Get('sent')
  @AuthenticatedOnly()
  sent(@Req() req: { user: { sub: string } }) {
    return this.workspacesService.findInvitesSentBy(req.user.sub);
  }

  /**
   * P2.0 (2026-05-15) — History filter chip on Received tab. Returns past
   * invitations addressed to the caller that are no longer pending
   * (accepted / declined / removed). Auditability without crowding the
   * primary pending list.
   */
  @Get('history')
  @AuthenticatedOnly()
  history(@Req() req: { user: { sub: string } }) {
    return this.workspacesService.findInviteHistoryForUser(req.user.sub);
  }

  /**
   * Wave 4 W4.7 (2026-05-10) — switcher accept flow. Authorizes via the
   * membership row's userId match (no token exposure required). Surfaces
   * the same side-effects as token-based accept: TeamMember flip, denylist
   * clear, audit + posthog.
   */
  @Post(':inviteId/accept')
  @AuthenticatedOnly()
  accept(@Param('inviteId') inviteId: string, @Req() req: { user: { sub: string } }) {
    return this.workspacesService.acceptInviteForUser(inviteId, req.user.sub);
  }

  @Delete(':inviteId')
  @AuthenticatedOnly()
  decline(@Param('inviteId') inviteId: string, @Req() req: { user: { sub: string } }) {
    return this.workspacesService.declineInviteForUser(inviteId, req.user.sub);
  }
}

/**
 * Wave 2 invite consolidation (2026-05-10).
 *
 * Single canonical token-resolution endpoint for both flows:
 *   - workspace-collaborator invites (no linked TeamMember)
 *   - team-member app-access invites (linked TeamMember)
 *
 * Accepts tokens produced by either the new `POST /workspaces/:wsId/invite`
 * (with optional `teamMemberId`) flow OR the deprecated
 * `POST /workspaces/:wsId/team/:memberId/grant-access` flow during the
 * one-release transition window — `team.grantAccess` dual-writes the same
 * token to a `WorkspaceMember` row so this endpoint resolves either source.
 *
 * SEC-5 (Workspaces hardening AC-2.1) — class-level `@LegacyUnclassified` debt
 * removed. The token preview + decline are `@Public`; the accept is the caller
 * acting on their own invite by token (no workspace context) → `@AuthenticatedOnly`.
 */
@Controller('invites/:token')
export class InvitesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  /**
   * @Public unauthenticated preview. Returns enough information for the
   * landing page to render "Workspace X invited you with role Y" without
   * forcing a login.
   */
  @Public()
  @Get()
  preview(@Param('token') token: string) {
    return this.workspacesService.getInviteDetails(token);
  }

  /**
   * Accept an invite. Wave 2 ships the authenticated path: caller signs in,
   * then POSTs here with their JWT. The unauthenticated atomic
   * signup-and-accept path is deferred to a follow-up wave (requires
   * AuthService orchestration for OTP + User creation in a single
   * transaction).
   *
   * On success: WorkspaceMember.status flips to 'active', any linked
   * TeamMember gets hasAppAccess=true + linkedUserId set, and the prior
   * revocation denylist entry (if any) is cleared (lifecycle L8).
   */
  @UseGuards(JwtAuthGuard)
  @AuthenticatedOnly()
  @Post('accept')
  accept(@Param('token') token: string, @Req() req: { user: { sub: string } }) {
    return this.workspacesService.joinWithToken(token, req.user.sub);
  }

  /**
   * @Public decline. Sets WorkspaceMember.status='declined'. Owner sees the
   * declined state in the member list. Existing user UI surfaces this from
   * the pending-invite badge in the workspace switcher.
   */
  @Public()
  @Delete()
  decline(@Param('token') token: string) {
    return this.workspacesService.declineInvite(token);
  }
}
