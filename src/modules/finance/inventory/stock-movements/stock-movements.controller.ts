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
import { StockMovementsService } from './stock-movements.service';

/**
 * Read-only controller for stock movement trail queries.
 * Requires either itemId or lotId query param (returns [] otherwise — T-09-04-06 DoS mitigation).
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/stock-movements')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.INVENTORY,
  subFeature: 'stock_movements_view',
})
export class StockMovementsController {
  constructor(private readonly service: StockMovementsService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('itemId') itemId?: string,
    @Query('godownId') godownId?: string,
    @Query('lotId') lotId?: string,
    @Query('movementType') movementType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // T-09-04-06: require itemId or lotId to prevent full-collection scan
    if (lotId) {
      return {
        success: true,
        data: await this.service.findByLot(wsId, firmId, lotId),
      };
    }

    if (itemId) {
      return {
        success: true,
        data: await this.service.findByItem(wsId, firmId, itemId, {
          godownId,
          movementType,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
        }),
      };
    }

    // Neither itemId nor lotId provided — return empty array
    return { success: true, data: [] };
  }
}
