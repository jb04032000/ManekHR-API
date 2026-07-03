import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { HrOverviewService } from './hr-overview.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../common/guards/roles.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';

@Controller('workspaces/:workspaceId/statistics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StatisticsController {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly hrOverviewService: HrOverviewService,
  ) {}

  @Get('dashboard')
  @RequirePermissions(AppModule.TEAM, ModuleAction.VIEW)
  getDashboardStats(@Param('workspaceId') workspaceId: string) {
    return this.statisticsService.getDashboardStats(workspaceId);
  }

  /**
   * HR OVERVIEW — the ManekHR admin landing metrics (headcount, this-month
   * salary, designation breakdown). Gated on SALARY VIEW scope=all so a
   * self-scoped worker can never read another member's salary figures; the
   * service additionally hides salary numbers when the SALARY module is off.
   * Feeds web `app/dashboard/page.tsx` HR overview via getHrOverview().
   */
  @Get('hr-overview')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getHrOverview(@Param('workspaceId') workspaceId: string) {
    return this.hrOverviewService.getOverview(workspaceId);
  }
}
