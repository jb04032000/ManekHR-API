import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { JwLotService } from './jw-lot.service';

/**
 * JwLotController — read-only Pending Material dashboard API.
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/jw/lots
 *
 * Both endpoints require 'view_reports' permission and 'job_work' subscription (D-14, D-15).
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/jw/lots')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.JOB_WORK, subFeature: 'lots' })
export class JwLotController {
  constructor(private readonly service: JwLotService) {}

  /**
   * GET /jw/lots?partyId=&status=pending,partial&page=1&pageSize=25
   * Returns pending/partial lots for the Pending Material dashboard.
   */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('partyId') partyId?: string,
    @Query('status') status?: string,
  ) {
    const statusList = status
      ? (status.split(',') as ('pending' | 'partial' | 'deemed_supply')[])
      : undefined;
    const data = await this.service.listPending({
      workspaceId: wsId,
      firmId,
      partyId,
      status: statusList,
    });
    return { success: true, data };
  }

  /**
   * GET /jw/lots/:id — lot detail with inwardChallanId for history lookup.
   * Scoped to the route's workspaceId + firmId to prevent cross-tenant access.
   */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async get(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    const doc = await this.service.getById(id, wsId, firmId);
    if (!doc) throw new NotFoundException('Lot not found');
    return { success: true, data: doc };
  }
}
