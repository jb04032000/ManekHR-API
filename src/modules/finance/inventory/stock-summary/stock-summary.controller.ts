import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import {
  RequirePermissions,
  RolesGuard,
} from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { StockSummaryService } from './stock-summary.service';
import { StockSummaryQueryDto } from './dto/stock-summary-query.dto';

/**
 * D-16 Stock Summary endpoints:
 *   GET  workspaces/:wsId/finance/firms/:firmId/inventory/stock-summary
 *   GET  workspaces/:wsId/finance/firms/:firmId/inventory/stock-summary/:itemId
 *
 * Powers the D-10 inventory landing page KPI strip + item table (plans 09-09/10).
 *
 * IMPORTANT: @Get(':itemId') must come AFTER @Get() to avoid routing conflicts.
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/stock-summary')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.INVENTORY,
  subFeature: 'stock_summary',
})
export class StockSummaryController {
  constructor(private readonly service: StockSummaryService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: StockSummaryQueryDto,
  ) {
    return {
      success: true,
      data: await this.service.list(wsId, firmId, query),
    };
  }

  @Get(':itemId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findByItem(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('itemId') itemId: string,
  ) {
    return {
      success: true,
      data: await this.service.findByItem(wsId, firmId, itemId),
    };
  }
}
