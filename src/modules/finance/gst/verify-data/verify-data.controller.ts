import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { VerifyDataService } from './verify-data.service';
import { VerifyDataRunDto, VerifyDataQueryDto } from './dto/verify-data-query.dto';

/**
 * VerifyDataController
 *
 * Base path: /workspaces/:wsId/firms/:firmId/verify-data
 *
 * All endpoints gated by JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: @RequireSubscription({ module: FINANCE, subFeature: 'gst_compliance' })
 * T-12-W4-02: workspace + firm path params scope all queries (no cross-firm leakage).
 * T-12-W4-03: subscription guard enforced on manual trigger endpoint.
 *
 * 2 endpoints per D-10:
 *   POST /verify-data/run     → manage_gst_compliance — trigger on-demand scan
 *   GET  /verify-data/results → view_gst_compliance   — list recent scan results
 */
@ApiTags('Finance - GST')
@Controller('workspaces/:wsId/firms/:firmId/verify-data')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'verify_my_data' })
export class VerifyDataController {
  constructor(private readonly service: VerifyDataService) {}

  /**
   * POST /workspaces/:wsId/firms/:firmId/verify-data/run
   *
   * Triggers an on-demand (manual) Verify-My-Data scan for the given period.
   * Requires manage_gst_compliance permission — this is a write/compute action.
   *
   * Returns the full VerifyDataResult document including all findings.
   * Client should check errorCount > 0 to gate GSTR-1 export.
   */
  @Post('run')
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async run(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: VerifyDataRunDto,
  ) {
    const data = await this.service.runScan(wsId, firmId, dto.period, 'manual');
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/verify-data/results?period=MMYYYY
   *
   * Lists recent scan results for the firm. period is optional query param.
   * Returns up to 50 results, newest first.
   *
   * view_gst_compliance permission is sufficient — this is a read action.
   */
  @Get('results')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async results(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() q: VerifyDataQueryDto,
  ) {
    const data = await this.service.listResults(wsId, firmId, q.period);
    return { success: true, data };
  }
}
