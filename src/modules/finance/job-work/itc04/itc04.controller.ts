import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { Itc04Service } from './itc04.service';
import { Itc04QueryDto } from './dto/itc04-query.dto';

/**
 * Itc04Controller
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/jw/itc04
 *
 * Permission mapping (D-14):
 *   GET /jw/itc04         → 'view_reports'      (tabular report)
 *   GET /jw/itc04/export  → 'generate_itc04'    (GSTN JSON download)
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/jw/itc04')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.JOB_WORK, subFeature: 'itc04' })
export class Itc04Controller {
  constructor(private readonly service: Itc04Service) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async report(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() q: Itc04QueryDto,
  ) {
    const data = await this.service.buildReport(wsId, firmId, q);
    return { success: true, data };
  }

  @Get('export')
  @RequirePermissions(AppModule.FINANCE, 'generate_itc04' as any)
  async export(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() q: Itc04QueryDto,
  ) {
    const data = await this.service.exportJson(wsId, firmId, q);
    return { success: true, data };
  }
}
