import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { ConnectRevenueService } from '../services/connect-revenue.service';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/**
 * Platform-admin Connect revenue dashboard (Phase M3.3).
 *
 * Base path: `admin/connect/revenue`
 * Guards: JwtAuthGuard + IsAdminGuard.
 *
 * Returns Connect subscription revenue (net of refunds, per plan). The web
 * dashboard reads boost / ad spend separately from `admin/connect/ads/revenue`.
 */
@LegacyUnclassified()
@Controller('admin/connect/revenue')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class ConnectRevenueAdminController {
  constructor(private readonly revenue: ConnectRevenueService) {}

  @Get()
  getRevenue() {
    return this.revenue.getSubscriptionRevenue();
  }
}
