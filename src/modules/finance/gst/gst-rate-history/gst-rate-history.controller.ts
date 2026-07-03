import { Body, Controller, Get, Logger, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';
import { GstRateHistoryService } from './gst-rate-history.service';
import { ReviseGstRateDto } from './dto/revise-gst-rate.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';

/**
 * finance/gst-rate-history — platform-global GST rate tables (D15). These rates are read by
 * every tenant, so reads are open to any authenticated user but REVISIONS are platform-admin
 * only (IsAdminGuard, NOT the workspace RolesGuard). Mirrors CessRulesController, which guards
 * the analogous platform-global cess registry the same way.
 */
@LegacyUnclassified()
@Controller('finance/gst-rate-history')
@UseGuards(JwtAuthGuard)
export class GstRateHistoryController {
  private readonly logger = new Logger(GstRateHistoryController.name);

  constructor(
    private readonly service: GstRateHistoryService,
    private readonly audit: AuditService,
  ) {}

  // R6: browse the whole rate registry (paginated, optional search) — the admin rate editor's
  // default view, so an admin no longer has to know a prefix to see anything. Declared BEFORE the
  // ':hsnPrefix' route so the bare path isn't captured as a prefix param.
  @Get()
  async listAll(
    @Query('q') q?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
  ) {
    const res = await this.service.listAll({
      q,
      skip: skip ? parseInt(skip, 10) : 0,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { success: true, ...res };
  }

  // Full rate timeline for an HSN/SAC prefix (e.g. '5208') — powers the admin rate editor.
  @Get(':hsnPrefix')
  async listForPrefix(@Param('hsnPrefix') hsnPrefix: string) {
    return { success: true, data: await this.service.listForPrefix(hsnPrefix) };
  }

  // Record a rate revision (platform admin only). Effective-dated; the service guarantees no
  // overlap and leaves prior rates intact so posted invoices keep their original rate.
  @Post('revise')
  @UseGuards(IsAdminGuard)
  async revise(@Body() dto: ReviseGstRateDto, @CurrentUser() user: any) {
    const created = await this.service.reviseRate({
      hsnPrefix: dto.hsnPrefix,
      fromDate: new Date(dto.fromDate),
      cgstRate: dto.cgstRate,
      sgstRate: dto.sgstRate,
      igstRate: dto.igstRate,
      cessRate: dto.cessRate,
      description: dto.description,
      notification: dto.notification,
      // R6: stamp who recorded the revision so the editor can show a who/when audit column.
      revisedBy: user._id ?? user.sub,
      revisedByName: user.name ?? user.fullName ?? user.email,
    });
    // D16/R6: a platform-global rate change affects EVERY tenant's tax computation, so record who
    // did it and when. workspaceId null = platform-level audit event (no single tenant). Awaited
    // (was a bare `void` with no catch = unhandled rejection risk) so the audit row is durably
    // written before we confirm the revision; a logging failure is warned, not fatal to the change.
    await this.audit
      .logEvent({
        workspaceId: null,
        module: AppModule.FINANCE,
        entityType: 'gst_rate',
        entityId: dto.hsnPrefix,
        action: 'finance.gst_rate_revised',
        actorId: user._id ?? user.sub,
        meta: {
          fromDate: dto.fromDate,
          cgstRate: dto.cgstRate,
          sgstRate: dto.sgstRate,
          igstRate: dto.igstRate,
          cessRate: dto.cessRate ?? 0,
          notification: dto.notification,
        },
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(`Audit failed for finance.gst_rate_revised (${dto.hsnPrefix}): ${detail}`);
      });
    return { success: true, data: created };
  }
}
