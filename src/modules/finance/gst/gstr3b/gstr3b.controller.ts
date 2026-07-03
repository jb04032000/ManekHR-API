import { Body, Controller, Get, Param, Patch, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { Gstr3bService } from './gstr3b.service';
import { Gstr3bQueryDto } from './dto/gstr3b-query.dto';
import { UpdateGstr3bAdjustmentDto } from './dto/update-gstr3b-adjustment.dto';

/**
 * Gstr3bController
 *
 * Base path: /workspaces/:wsId/firms/:firmId/gstr3b
 *
 * All endpoints gated by JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: @RequireSubscription({ module: FINANCE, subFeature: 'gst_compliance' })
 * T-12-W3-17 mitigation: Starter plan blocked from all GSTR-3B endpoints.
 *
 * 3 endpoints per D-10:
 *   GET    /gstr3b              → view_gst_compliance   — merged report (auto + adjustments)
 *   PATCH  /gstr3b/adjustments  → manage_gst_compliance — save manual cell overrides (upsert)
 *   GET    /gstr3b/export       → manage_gst_compliance — GSTN-spec JSON file download
 *
 * T-12-W3-16 mitigation: workspace + firm path params scope all queries.
 * T-12-W3-18 mitigation: savedBy captured from JWT user on PATCH.
 *
 * Export endpoint uses @Res() to bypass global response-envelope interceptor
 * and set Content-Disposition for JSON file download.
 */
@ApiTags('Finance - GST')
@Controller('workspaces/:wsId/firms/:firmId/gstr3b')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr3b_filing' })
export class Gstr3bController {
  constructor(private readonly service: Gstr3bService) {}

  /**
   * GET /workspaces/:wsId/firms/:firmId/gstr3b?period=MMYYYY
   *
   * Returns the merged GSTR-3B report:
   * - auto-computed values from LedgerEntry aggregation
   * - manual adjustment overrides (if any)
   * - nov2025Locked flag for Table 3.2 cells
   * - finalValues map with per-cell autoValue / manualValue / isManual / nov2025Locked
   */
  @Get()
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async getReport(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: Gstr3bQueryDto,
  ) {
    const data = await this.service.getReport(wsId, firmId, query.period);
    return { success: true, data };
  }

  /**
   * PATCH /workspaces/:wsId/firms/:firmId/gstr3b/adjustments
   *
   * Persists manual cell overrides for the period.
   * Uses upsert — safe to call multiple times (T-12-W3-14 mitigation).
   * Records savedBy from JWT user for audit trail (T-12-W3-18 mitigation).
   * Rejects unknown cell keys (T-12-W3-15 mitigation).
   */
  @Patch('adjustments')
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async saveAdjustments(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateGstr3bAdjustmentDto,
    @Req() req: Request & { user?: { id?: string; _id?: string } },
  ) {
    const savedBy = req.user?.id ?? req.user?._id;
    const data = await this.service.saveAdjustments(
      wsId,
      firmId,
      dto.period,
      dto.adjustments,
      dto.narration,
      savedBy,
    );
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/gstr3b/export?period=MMYYYY
   *
   * Downloads the GSTR-3B JSON file in GSTN v2.x spec format.
   * Sets Content-Type: application/json and Content-Disposition: attachment.
   * Filename: GSTR3B_{GSTIN}_{period}.json
   *
   * Uses @Res() (Express) to bypass global response-envelope interceptor.
   * manage_gst_compliance required — export is a privileged "filing" action (D-11).
   */
  @Get('export')
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async exportJson(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: Gstr3bQueryDto,
    @Res() res: Response,
  ) {
    const { filename, payload } = await this.service.exportJson(wsId, firmId, query.period);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(JSON.stringify(payload, null, 2));
  }
}
