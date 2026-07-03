import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { ApiTags } from '@nestjs/swagger';
import { CapitalGoodsItcService } from './capital-goods-itc.service';

@ApiTags('Finance - Purchases')
@Controller('workspaces/:wsId/finance/firms/:firmId/purchases/capital-goods-itc')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_capital_goods_itc' })
export class CapitalGoodsItcController {
  constructor(private readonly service: CapitalGoodsItcService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('status') status?: string,
  ) {
    return this.service.listForFirm(wsId, firmId, status);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findOne(wsId, firmId, id);
  }
}
