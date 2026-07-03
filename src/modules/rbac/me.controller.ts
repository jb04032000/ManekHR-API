import { Controller, Get, Param, Req, Sse, UseGuards, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacService } from './rbac.service';
import { AuthenticatedOnly } from '../../common/decorators/require-permission.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';
import { PermissionEventsService } from '../../common/realtime/permission-events.service';

/**
 * Per-workspace `me` endpoints — answer "what can I do in this workspace?"
 * without requiring any specific permission.
 *
 * Mounted at `/workspaces/:workspaceId/me`. Only JwtAuthGuard runs; RolesGuard
 * is intentionally absent because the lookup itself is the authorisation
 * answer (not a guarded resource).
 *
 * Access classification: `@AuthenticatedOnly` — these endpoints ARE the
 * permission answer, so they require an authenticated user but no specific
 * grant. This is a NO-BEHAVIOUR-CHANGE reclassification from the transitional
 * `@LegacyUnclassified` marker (RBAC-hardening Pillar 2 / SEC-5): RolesGuard
 * treats both markers identically (catch-all branch 5 → allow), but
 * `@AuthenticatedOnly` is the semantically-correct, permanent marker and clears
 * this controller from the legacy-reclassification backlog. The service
 * (`RbacService.getMyPermissions`) still enforces workspace membership
 * internally and throws 403 for a non-member.
 */
@AuthenticatedOnly()
@Controller('workspaces/:workspaceId/me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(
    private readonly rbacService: RbacService,
    private readonly permissionEvents: PermissionEventsService,
  ) {}

  @Get('permissions')
  getPermissions(@Param('workspaceId') workspaceId: string, @Req() req: { user: { sub: string } }) {
    return this.rbacService.getMyPermissions(workspaceId, req.user.sub);
  }

  /**
   * SSE stream. Pushes a `permission-change` event to the caller's open
   * connection the instant an admin edits their role/overrides, so the web
   * client re-fetches `/me/permissions` immediately (no 60s notification-poll
   * lag, no manual reload). A 25s `ping` heartbeat keeps proxies from idle-
   * closing the stream.
   *
   * `@SkipPinUnlock()` so the stream survives an app-lock cycle; it carries
   * no sensitive data (only "your access changed, refetch"), and the refetch
   * it triggers (`GET /me/permissions`) is itself still PIN-gated. Only
   * `JwtAuthGuard` runs here (the controller is `@LegacyUnclassified`, no
   * `RolesGuard`), so a permission edit can never lock the caller out of their
   * own change-notification channel.
   */
  @Sse('permission-events')
  @SkipPinUnlock()
  permissionEventsStream(
    @Param('workspaceId') workspaceId: string,
    @Req() req: { user: { sub: string } },
  ): Observable<MessageEvent> {
    return this.permissionEvents.streamForUser(req.user.sub, workspaceId);
  }
}
