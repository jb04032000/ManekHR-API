import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { EInvoiceService } from './einvoice.service';
import { MfaCompleteDto } from './dto/mfa-complete.dto';
import { CancelIrnDto } from './dto/cancel-irn.dto';
import { BatchIrnDto } from './dto/batch-irn.dto';

/**
 * EInvoiceController
 *
 * Base path: /workspaces/:wsId/firms/:firmId/einvoice
 *
 * All routes require JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: @SubscriptionFeature('gst_compliance') (Pro+ plan — D-12).
 *
 * 6 endpoints per D-10:
 *   POST /prepare-session          — manage_gst_compliance
 *   POST /complete-session         — manage_gst_compliance
 *   POST /:invoiceId/generate      — manage_gst_compliance
 *   POST /:invoiceId/cancel        — manage_gst_compliance
 *   POST /batch-generate           — manage_gst_compliance
 *   GET  /pending                  — view_gst_compliance
 *
 * T-12-W3-04: @SubscriptionFeature gates Starter plans; SubscriptionGuard rejects requests
 * from firms without Pro+ entitlement.
 * T-12-W3-02: All endpoints scoped to workspaceId + firmId path params; RBAC gates actions.
 */
@ApiTags('Finance - Sales')
@Controller('workspaces/:wsId/firms/:firmId/einvoice')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'einvoice_generation' })
export class EInvoiceController {
  constructor(private readonly service: EInvoiceService) {}

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/prepare-session
   *
   * Initiates or checks IRP session for the firm.
   * SurePass mode: always returns { sessionReady: true }.
   * NIC Direct mode: returns { needsOtp: true, sessionId } or { sessionReady: true } if cached.
   */
  @Post('prepare-session')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async prepareSession(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    const data = await this.service.prepareSession(wsId, firmId);
    return { success: true, data };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/complete-session
   *
   * Completes NIC Direct OTP flow. Returns { sessionReady: true } on success.
   * Only applicable for mode=nic_direct firms.
   */
  @Post('complete-session')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async completeSession(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: MfaCompleteDto,
  ) {
    const data = await this.service.completeSession(wsId, firmId, dto.sessionId, dto.otp);
    return { success: true, data };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/:invoiceId/generate
   *
   * Generates IRN for a single posted invoice.
   * Idempotent: if IRN already generated, returns existing IRN.
   * Returns { irn, ackNo, ackDate, signedQrCode }.
   */
  @Post(':invoiceId/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async generateIrn(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: any,
  ) {
    // user._id ?? user.sub mirrors sale-invoice.controller - threads the actor to PostHog.
    const data = await this.service.generateIrn(wsId, firmId, invoiceId, user._id ?? user.sub);
    return { success: true, data };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/credit-note/:creditNoteId/generate
   *
   * Generates IRN for a posted credit note (CRN). Same guards as the invoice path; the
   * payload includes PrecDocDtls (the original invoice). 3-segment path so it never collides
   * with :invoiceId/generate. Cross-link: EInvoiceService.generateIrnForCreditNote.
   */
  @Post('credit-note/:creditNoteId/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async generateCreditNoteIrn(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('creditNoteId') creditNoteId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.service.generateIrnForCreditNote(
      wsId,
      firmId,
      creditNoteId,
      user._id ?? user.sub,
    );
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/einvoice/credit-note/:creditNoteId/qr
   *
   * Returns the credit note's signed QR as a base64 PNG data URL (mirrors the invoice QR).
   */
  @Get('credit-note/:creditNoteId/qr')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async getCreditNoteQr(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('creditNoteId') creditNoteId: string,
  ) {
    const data = await this.service.getCreditNoteQr(wsId, firmId, creditNoteId);
    return { success: true, data };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/credit-note/:creditNoteId/cancel
   *
   * Cancels a credit note's IRN within the 24-hour window. Reason codes 1-4.
   * Cross-link: EInvoiceService.cancelIrnForCreditNote.
   */
  @Post('credit-note/:creditNoteId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async cancelCreditNoteIrn(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('creditNoteId') creditNoteId: string,
    @Body() dto: CancelIrnDto,
    @CurrentUser() user: any,
  ) {
    await this.service.cancelIrnForCreditNote(
      wsId,
      firmId,
      creditNoteId,
      dto.cancelReason,
      dto.cancelRemarks,
      user._id ?? user.sub,
    );
    return { success: true, data: { cancelled: true } };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/:invoiceId/cancel
   *
   * Cancels an IRN within the 24-hour window.
   * Throws 'IRN_CANCEL_WINDOW_EXPIRED' (400) if window has passed.
   */
  @Post(':invoiceId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async cancelIrn(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CancelIrnDto,
    @CurrentUser() user: any,
  ) {
    await this.service.cancelIrn(
      wsId,
      firmId,
      invoiceId,
      dto.cancelReason,
      dto.cancelRemarks,
      user._id ?? user.sub,
    );
    return { success: true, data: { cancelled: true } };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/einvoice/batch-generate
   *
   * Batch IRN generation: processes first 100 synchronously, enqueues remainder.
   * Returns { processed, queued } counts.
   * T-12-W3-05: DTO caps at 500 invoices; service splits at 100 + BullMQ queue.
   */
  @Post('batch-generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async batchGenerate(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: BatchIrnDto,
  ) {
    const data = await this.service.batchGenerate(wsId, firmId, dto.invoiceIds);
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/einvoice/pending
   *
   * Lists invoices pending e-Invoice generation.
   * Applicable when firm.aato > 5 Cr (mandatory e-Invoice threshold).
   */
  @Get('pending')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async listPending(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    const data = await this.service.listPending(wsId, firmId);
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/einvoice/list?status=generated|cancelled|failed|retry&page=0&size=50
   *
   * Lists invoices filtered by eInvoice.status with pagination.
   * Used by web UI tabs: Generated / Cancelled / Retry Queue.
   */
  @Get('list')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async listByStatus(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('status') status: 'pending' | 'generated' | 'cancelled' | 'failed' | 'retry' = 'pending',
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const data = await this.service.listByStatus(
      wsId,
      firmId,
      status,
      page ? parseInt(page, 10) : 0,
      size ? parseInt(size, 10) : 50,
    );
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/einvoice/:invoiceId/qr
   *
   * Returns the signed QR code as a base64 PNG data URL for the QR preview modal.
   * Backend renders via qrcode package so no frontend QR library is needed.
   */
  @Get(':invoiceId/qr')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async getQr(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    const data = await this.service.getEInvoiceQr(wsId, firmId, invoiceId);
    return { success: true, data };
  }
}
