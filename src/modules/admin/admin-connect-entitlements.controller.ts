import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { AdminConnectEntitlementsService } from './admin-connect-entitlements.service';
import { AdminConnectEntitlementsOverrideDto } from './dto/admin-connect-entitlements.dto';

/**
 * Admin per-user Connect entitlements console.
 *
 * Routes under `admin/connect/users/:id/entitlements`, guarded class-wide by
 * JwtAuthGuard + IsAdminGuard (same convention as AdminController), so every
 * method is admin-only and a non-admin gets a 403 before the handler runs.
 *
 *   GET                       → plan defaults vs override vs effective + usage
 *   PUT  .../override          → set/replace the connect override (partial)
 *   DELETE .../override        → clear the connect override (restore plan values)
 *
 * Separate controller (not folded into AdminController) so it can inject the
 * Connect allowance/usage services without bloating the core admin controller's
 * dependency surface. Linked to: admin-connect-entitlements.service.ts.
 */
@LegacyUnclassified()
@Controller('admin/connect/users/:id/entitlements')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class AdminConnectEntitlementsController {
  constructor(private readonly service: AdminConnectEntitlementsService) {}

  @Get()
  get(@Param('id') id: string) {
    return this.service.getEntitlements(id);
  }

  @Put('override')
  setOverride(
    @Param('id') id: string,
    @Body() dto: AdminConnectEntitlementsOverrideDto,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.service.setOverride(id, dto, actorId);
  }

  @Delete('override')
  clearOverride(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    return this.service.clearOverride(id, actorId);
  }
}
