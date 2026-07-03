import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { FiscalYearService } from './fiscal-year.service';
import { FyCloseService } from './fy-close.service';
import { HealthChecksService } from './health-checks.service';
import { CloseFyDto } from './dto/close-fy.dto';
import { ReopenFyDto } from './dto/reopen-fy.dto';

/**
 * Fiscal-Year controller.
 *
 * Auth gates (in order, per D-44):
 *   JwtAuthGuard → RolesGuard → SubscriptionGuard
 *
 * Subscription: `finance_advanced` (D-43, no new SKU).
 * Permissions: tally_export / fy_close / fy_reopen (D-42 — owner-only by
 * default; can be granted to admin/finance roles via role matrix UI).
 *
 * Path: /workspaces/:wsId/firms/:firmId/fiscal-year — workspace + firm scoped
 * per repo convention.
 */
@ApiTags('Finance - Settings')
@Controller('workspaces/:wsId/firms/:firmId/fiscal-year')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.FINANCE,
  subFeature: 'accounting_fiscal_years',
})
export class FiscalYearController {
  constructor(
    private readonly fyService: FiscalYearService,
    private readonly fyClose: FyCloseService,
    private readonly healthChecks: HealthChecksService,
  ) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, 'fy_close' as any)
  async list(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.fyService.listForFirm(wsId, firmId);
  }

  @Get('current')
  @RequirePermissions(AppModule.FINANCE, 'fy_close' as any)
  async current(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.fyService.getCurrentFy(wsId, firmId);
  }

  @Get(':id/health-checks')
  @RequirePermissions(AppModule.FINANCE, 'fy_close' as any)
  async health(
    @Param('id') id: string,
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
  ) {
    return this.healthChecks.runChecks(wsId, firmId, id);
  }

  @Post(':id/close')
  @RequirePermissions(AppModule.FINANCE, 'fy_close' as any)
  async close(
    @Param('id') id: string,
    @Body() dto: CloseFyDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.fyClose.close(
      { ...dto, fyId: id },
      user.id ?? user._id ?? user.userId,
      req.ip,
      req.headers?.['user-agent'],
    );
  }

  @Post(':id/reopen')
  @RequirePermissions(AppModule.FINANCE, 'fy_reopen' as any)
  async reopen(
    @Param('id') id: string,
    @Body() dto: ReopenFyDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.fyClose.reopen(
      { ...dto, fyId: id },
      user.id ?? user._id ?? user.userId,
      req.ip,
      req.headers?.['user-agent'],
    );
  }
}
