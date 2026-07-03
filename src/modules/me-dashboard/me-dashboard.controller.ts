import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { MeDashboardService } from './me-dashboard.service';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/**
 * Wave B Permission-Gated UI (2026-05-15) — self-scoped dashboard for
 * restricted invitees. Mounted under `/workspaces/:workspaceId/me/...`
 * to match the existing `me` namespace pattern (`/me/permissions`,
 * `/me/notifications`).
 *
 * Auth: JwtAuthGuard only. The service does the membership lookup; no
 * `@RequirePermissions` decorator because the bundle is by definition
 * self-scope (returns only the caller's own data). A non-member of the
 * workspace gets an empty bundle, not a 403 — keeps the response shape
 * stable for FE while leaking nothing (only the caller's own
 * teamMember._id is included, which they already own).
 */
@LegacyUnclassified()
@Controller('workspaces/:workspaceId/me/dashboard')
@UseGuards(JwtAuthGuard)
export class MeDashboardController {
  constructor(private readonly meDashboardService: MeDashboardService) {}

  @Get()
  getDashboard(@Req() req: { user: { sub: string } }, @Param('workspaceId') workspaceId: string) {
    return this.meDashboardService.getDashboard(req.user.sub, workspaceId);
  }
}
