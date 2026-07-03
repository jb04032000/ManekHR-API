import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { ApiTags } from '@nestjs/swagger';
import { PayablesListingService } from './payables-listing.service';

@ApiTags('Finance - Purchases')
@Controller('workspaces/:wsId/finance/firms/:firmId/purchases/payables')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_payables' })
export class PayablesListingController {
  constructor(private readonly service: PayablesListingService) {}

  @Get('aging')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getAgingBuckets(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    return this.service.getAgingBuckets(wsId, firmId, asOfDate ? new Date(asOfDate) : undefined);
  }

  @Get('summary')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getPayablesSummary(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.service.getPayablesSummary(wsId, firmId);
  }
}
