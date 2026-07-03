import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { Gstr1Service } from './gstr1.service';
import { Gstr1QueryDto } from './dto/gstr1-query.dto';

/**
 * Gstr1Controller
 *
 * Base path: /workspaces/:wsId/firms/:firmId/gstr1
 *
 * All endpoints gated by JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: @SubscriptionFeature('gst_compliance') (Pro+ plan — D-12).
 * T-12-W3-11 mitigation: Starter plan blocked from all GSTR-1 endpoints.
 *
 * 3 endpoints per D-10:
 *   GET /gstr1          → view_gst_compliance  — report with section arrays + _counts
 *   GET /gstr1/validate → view_gst_compliance  — pre-flight findings array
 *   GET /gstr1/export   → manage_gst_compliance — JSON file download (privileged "filing" action)
 *
 * Export endpoint uses @Res() to bypass global response-envelope interceptor
 * and set Content-Disposition for JSON file download.
 * T-12-W3-08: workspace + firm path params scope all queries.
 */
@ApiTags('Finance - GST')
@Controller('workspaces/:wsId/firms/:firmId/gstr1')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr1_filing' })
export class Gstr1Controller {
  constructor(private readonly service: Gstr1Service) {}

  /**
   * GET /workspaces/:wsId/firms/:firmId/gstr1?period=MMYYYY
   *
   * Returns the full GSTR-1 report for the period.
   * Includes all 11 section arrays + _counts (for dashboard display).
   */
  @Get()
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async getReport(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: Gstr1QueryDto,
  ) {
    const data = await this.service.getReport(wsId, firmId, query.period);
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/gstr1/validate?period=MMYYYY
   *
   * Runs 5 pre-flight checks for the period.
   * Returns { findings: VerifyDataFinding[] }.
   * User can proceed to export despite findings (advisory, not blocking).
   */
  @Get('validate')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async validate(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: Gstr1QueryDto,
  ) {
    const findings = await this.service.validatePeriod(wsId, firmId, query.period);
    return { success: true, data: { findings } };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/gstr1/export?period=MMYYYY
   *
   * Downloads the GSTR-1 JSON file.
   * Sets Content-Type: application/json and Content-Disposition: attachment.
   * Filename: GSTR1_{GSTIN}_{period}.json
   *
   * Uses @Res() (Express) to bypass global response-envelope interceptor.
   * manage_gst_compliance required — export is a privileged "filing" action (D-11).
   */
  @Get('export')
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async exportJson(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: Gstr1QueryDto,
    @Res() res: Response,
  ) {
    const { filename, payload } = await this.service.exportJson(wsId, firmId, query.period);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(JSON.stringify(payload, null, 2));
  }
}
