import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule } from '../../../common/enums/modules.enum';
import { TallyExportService } from './tally-export.service';
import { GenerateExportDto } from './dto/generate-export.dto';

/**
 * TallyExportController — base path `/workspaces/:wsId/tally-export`.
 *
 * Two endpoints (D-08):
 *   POST /                  — generate XML export, stream as attachment
 *   GET  /validator-report  — pre-flight warning report for a date range
 *
 * Guards: JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: `finance_advanced` (D-43 — no new SKU).
 * Permission gate: `tally_export` (D-42, FINANCE_F15_PERMISSIONS).
 *
 * Response envelope: POST uses @Res() to bypass the global envelope and stream
 * the XML file as `Content-Type: application/xml; Content-Disposition: attachment`.
 * Validator headers `X-Tally-Voucher-Count` + `X-Tally-Warning-Count` carry the
 * stats so the UI can show "exported N vouchers, M warnings" without parsing
 * the body.
 */
@ApiTags('Finance - Settings')
@Controller('workspaces/:wsId/tally-export')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_tally_export' })
export class TallyExportController {
  constructor(private readonly service: TallyExportService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, 'tally_export' as any)
  async generate(
    @Param('wsId') wsId: string,
    @Body() dto: GenerateExportDto,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const userId = req.user?.sub ?? '';
    const result = await this.service.runExport(wsId, dto, userId);

    if (result.status === 'queued') {
      res.status(202).json({ success: true, data: { status: 'queued', jobId: result.jobId } });
      return;
    }

    const filename = `tally-export-${dto.firmId}-${dto.fromDate.slice(0, 10)}-${dto.toDate.slice(0, 10)}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Tally-Voucher-Count', String(result.voucherCount ?? 0));
    res.setHeader('X-Tally-Warning-Count', String(result.report?.warnings.length ?? 0));
    res.setHeader('Content-Length', String(result.fileSize ?? 0));

    if (!result.filePath) {
      res.status(500).json({ success: false, error: 'No file generated' });
      return;
    }
    const stream = createReadStream(result.filePath);
    stream.on('error', (err) => {
      res.status(500).end(err.message);
    });
    stream.pipe(res);
  }

  @Get('validator-report')
  @RequirePermissions(AppModule.FINANCE, 'tally_export' as any)
  async validate(
    @Param('wsId') wsId: string,
    @Query('firmId') firmId: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
  ) {
    const data = await this.service.getValidatorReport(wsId, firmId, fromDate, toDate);
    return { success: true, data };
  }

  /**
   * GET /recent — last-N tally exports for a firm (D-11 audit-log projection).
   *
   * Reads the audit-event collection (entityType='tally-export', entityId=firmId)
   * sorted desc by createdAt; surfaces the meta payload the service writes on
   * every successful export. Plan 16-06 Wave-3 dependency.
   */
  @Get('recent')
  @RequirePermissions(AppModule.FINANCE, 'tally_export' as any)
  async listRecent(
    @Param('wsId') wsId: string,
    @Query('firmId') firmId: string,
    @Query('limit') limit?: string,
  ) {
    const cap = Math.min(Math.max(parseInt(limit ?? '10', 10) || 10, 1), 50);
    const rows = await this.service.listRecentExports(wsId, firmId, cap);
    return { success: true, data: { rows } };
  }
}
