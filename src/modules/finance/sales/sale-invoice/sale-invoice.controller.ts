import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { SaleInvoiceService } from './sale-invoice.service';
import { CreateSaleInvoiceDto } from './dto/create-sale-invoice.dto';
import { UpdateSaleInvoiceDto } from './dto/update-sale-invoice.dto';
import { EInvoiceService } from '../einvoice/einvoice.service';
import { EwaybillService } from '../ewaybill/ewaybill.service';
import { EwbRequestDto } from '../ewaybill/dto/ewb-request.dto';
import { FirmsService } from '../../firms/firms.service';
import { GstRateHistoryService } from '../../gst/gst-rate-history/gst-rate-history.service';
import { PrintService } from '../print/print.service';

/**
 * SaleInvoiceController — exposes the full D-24 endpoint set plus sale-invoice-specific actions.
 *
 * Prefix: workspaces/:wsId/finance/firms/:firmId/sales/invoices
 *
 * IMPORTANT: @Get('kpi-summary') MUST be declared before @Get(':id') to prevent
 * NestJS routing 'kpi-summary' as an :id param.
 */
@ApiTags('Finance - Sales')
@Controller('workspaces/:wsId/finance/firms/:firmId/sales/invoices')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'sales_invoicing' })
export class SaleInvoiceController {
  constructor(
    private readonly service: SaleInvoiceService,
    private readonly einvoiceService: EInvoiceService,
    private readonly ewaybillService: EwaybillService,
    private readonly firmsService: FirmsService,
    private readonly gstRateHistory: GstRateHistoryService,
    private readonly printService: PrintService,
  ) {}

  // ─── list ──────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('finance.invoice.view', 'self')
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Query() filters: any) {
    return this.service.list(wsId, firmId, filters);
  }

  // ─── kpi-summary (D-26) — MUST be before @Get(':id') ─────────────────────

  @Get('kpi-summary')
  @RequirePermission('finance.invoice.view', 'self')
  kpiSummary(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return this.service.computeKpiSummary(
      wsId,
      firmId,
      dateFrom ? new Date(dateFrom) : defaultFrom,
      dateTo ? new Date(dateTo) : defaultTo,
    );
  }

  // ─── gst-rate lookup (2b) — MUST be before @Get(':id') ──────────────────────

  /**
   * GET .../sales/invoices/gst-rate?hsn=5402&date=2025-10-01
   *
   * Looks up the master GST rate for an HSN/SAC at a given date so the line
   * editor can default the tax rate and warn when the entered rate differs.
   * Returns found:false (no error) when the HSN has no rate-history coverage so
   * the caller falls back to manual entry.
   */
  @Get('gst-rate')
  @RequirePermission('finance.invoice.view', 'self')
  async gstRateLookup(@Query('hsn') hsn?: string, @Query('date') date?: string) {
    const cleaned = (hsn ?? '').replace(/\D/g, '');
    if (!cleaned) {
      throw new BadRequestException('hsn is required');
    }
    const asOf = date ? new Date(date) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      throw new BadRequestException('date is invalid');
    }
    const row = await this.gstRateHistory.getRateAsOf(cleaned, asOf);
    if (!row) {
      return { success: true, data: { hsn: cleaned, asOf, found: false } };
    }
    return {
      success: true,
      data: {
        hsn: cleaned,
        asOf,
        found: true,
        matchedPrefix: row.hsnPrefix,
        description: row.description,
        cgstRate: row.cgstRate,
        sgstRate: row.sgstRate,
        igstRate: row.igstRate,
        cessRate: row.cessRate ?? 0,
        // Total intra-state rate (cgst + sgst), which equals igst for symmetric rows.
        totalRate: row.igstRate,
        notification: row.notification,
      },
    };
  }

  // ─── findOne ───────────────────────────────────────────────────────────────

  @Get(':id')
  @RequirePermission('finance.invoice.view', 'self')
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findOne(wsId, firmId, id);
  }

  // ─── print ─────────────────────────────────────────────────────────────────

  @Get(':id/print')
  @RequirePermission('finance.invoice.view', 'self')
  print(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Query('template') template?: string,
  ) {
    return this.service.findOne(wsId, firmId, id).then((invoice) => ({
      invoice,
      template: template ?? 'a4-theme1',
    }));
  }

  // ─── server-rendered PDF (1c) ────────────────────────────────────────────────
  // Streams a Noto-font PDF rendered server-side. Used by the web client to
  // print/download invoices in Gujarati / Hindi script, which the in-browser
  // jsPDF themes cannot shape. `locale` = en | gu | hi; `theme` = classic | modern.
  @Get(':id/pdf')
  @RequirePermission('finance.invoice.view', 'self')
  async pdf(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('locale') locale?: string,
    @Query('theme') theme?: string,
  ): Promise<void> {
    const invoice = await this.service.findOne(wsId, firmId, id);
    const firm = await this.firmsService.findOne(wsId, firmId);
    const party = (invoice as { partySnapshot?: Record<string, unknown> }).partySnapshot ?? {};
    const buffer = await this.printService.renderInvoicePdf(invoice, party, firm, {
      locale: locale === 'gu' || locale === 'hi' ? locale : 'en',
      themeId: theme,
    });
    const fileName = `${(invoice as { voucherNumber?: string }).voucherNumber ?? 'invoice'}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName}"`,
    });
    res.send(buffer);
  }

  // ─── create ────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermission('finance.invoice.create', 'self')
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateSaleInvoiceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createDraft(wsId, firmId, dto, user._id ?? user.sub);
  }

  // ─── update ────────────────────────────────────────────────────────────────

  @Patch(':id')
  @RequirePermission('finance.invoice.edit', 'self')
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSaleInvoiceDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateDraft(wsId, firmId, id, dto, user._id ?? user.sub);
  }

  // ─── post (D-19: X-Idempotency-Key header) ────────────────────────────────

  @Post(':id/post')
  @RequirePermission('finance.invoice.post', 'self')
  postInvoice(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @CurrentUser() user: any,
  ) {
    return this.service.postInvoice(wsId, firmId, id, user._id ?? user.sub, idempotencyKey);
  }

  // ─── approve / reject (maker-checker D-15) ────────────────────────────────

  @Post(':id/approve')
  @RequirePermission('finance.invoice.edit', 'self')
  approve(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.approve(wsId, firmId, id, user._id ?? user.sub);
  }

  @Post(':id/reject')
  @RequirePermission('finance.invoice.edit', 'self')
  reject(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.reject(wsId, firmId, id, user._id ?? user.sub, body.reason);
  }

  // ─── cancel ────────────────────────────────────────────────────────────────

  @Post(':id/cancel')
  @RequirePermission('finance.invoice.edit', 'self')
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(wsId, firmId, id, body.reason, user._id ?? user.sub);
  }

  // ─── clone ─────────────────────────────────────────────────────────────────

  @Post(':id/clone')
  @RequirePermission('finance.invoice.create', 'self')
  clone(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.clone(wsId, firmId, id, user._id ?? user.sub);
  }

  // ─── send (D-27: email wired, whatsapp/sms stub) ──────────────────────────

  @Post(':id/send')
  @RequirePermission('finance.invoice.send')
  send(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { channels: string[]; message?: string; recipientEmail?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.sendVoucher(wsId, firmId, id, body, user._id ?? user.sub);
  }

  // ─── e-Invoice IRN (D-05) ─────────────────────────────────────────────────

  @Post(':id/einvoice')
  @RequirePermission('finance.invoice.edit', 'self')
  einvoice(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    // Thread the actor so EInvoiceService emits sales.generated_irn for this route too.
    return this.einvoiceService.generateIrn(wsId, firmId, id, user._id ?? user.sub);
  }

  // ─── e-Way Bill (D-06) ────────────────────────────────────────────────────

  @Post(':id/ewaybill')
  @RequirePermission('finance.invoice.edit', 'self')
  ewaybill(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: EwbRequestDto,
    @CurrentUser() user: any,
  ) {
    // Thread the actor so EwaybillService emits sales.generated_eway_bill for this route too.
    return this.ewaybillService.generate(wsId, firmId, id, dto, user._id ?? user.sub);
  }

  // Recording-only product: no UPI-QR / Razorpay payment-link endpoints. Payment
  // is collected outside the app; the invoice only records what was received.

  // ─── late-fee override ────────────────────────────────────────────────────

  @Post(':id/late-fee-override')
  @RequirePermission('finance.invoice.edit', 'self')
  lateFeeOverride(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { type: string; value: number; gracePeriodDays: number },
    @CurrentUser() user: any,
  ) {
    return this.service.applyLateFeeOverride(wsId, firmId, id, body, user._id ?? user.sub);
  }

  // ─── void (soft-delete draft) ─────────────────────────────────────────────

  @Delete(':id')
  @RequirePermission('finance.invoice.delete', 'self')
  voidDraft(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.voidDraft(wsId, firmId, id, user._id ?? user.sub);
  }
}
