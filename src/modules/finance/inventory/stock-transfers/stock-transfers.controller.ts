import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { StockTransfersService } from './stock-transfers.service';
import { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import { UpdateStockTransferDto } from './dto/update-stock-transfer.dto';

@Controller(
  'workspaces/:wsId/finance/firms/:firmId/inventory/transfers',
)
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.INVENTORY,
  subFeature: 'stock_transfers',
})
export class StockTransfersController {
  constructor(private readonly service: StockTransfersService) {}

  /** GET /workspaces/:wsId/finance/firms/:firmId/inventory/transfers */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return {
      success: true,
      data: await this.service.list(wsId, firmId, {
        status,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      }),
    };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/inventory/transfers/:id */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findById(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return {
      success: true,
      data: await this.service.findById(wsId, firmId, id),
    };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/inventory/transfers */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateStockTransferDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.create(wsId, firmId, dto, user._id ?? user.sub),
    };
  }

  /** PATCH /workspaces/:wsId/finance/firms/:firmId/inventory/transfers/:id */
  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateStockTransferDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.update(wsId, firmId, id, dto, user._id ?? user.sub),
    };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/inventory/transfers/:id/post */
  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.post(wsId, firmId, id, user._id ?? user.sub),
    };
  }

  /** DELETE /workspaces/:wsId/finance/firms/:firmId/inventory/transfers/:id */
  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    await this.service.delete(wsId, firmId, id, user._id ?? user.sub);
    return { success: true, data: { deleted: true } };
  }
}
