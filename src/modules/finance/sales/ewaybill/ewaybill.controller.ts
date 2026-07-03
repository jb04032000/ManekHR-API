import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { EwaybillService } from './ewaybill.service';
import { GenerateEwbDto } from './dto/generate-ewb.dto';
import { ExtendEwbDto } from './dto/extend-ewb.dto';
import { CancelEwbDto } from './dto/cancel-ewb.dto';

/**
 * EwaybillController
 *
 * Base path: /workspaces/:wsId/firms/:firmId/ewaybill
 *
 * All routes require JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: @SubscriptionFeature('gst_compliance') (Pro+ plan — D-12).
 *
 * 4 endpoints per D-10:
 *   POST  /:invoiceId/generate   — manage_gst_compliance
 *   PATCH /:invoiceId/extend     — manage_gst_compliance
 *   POST  /:invoiceId/cancel     — manage_gst_compliance
 *   GET   /expiring              — view_gst_compliance
 *
 * T-12-W3-02: Workspace-scoped via path params; RBAC gates each action.
 * T-12-W3-04: @SubscriptionFeature('gst_compliance') blocks Starter firms.
 * T-12-W3-06: EWB docDate read from invoice.voucherDate (server-stored) — client cannot override.
 */
@ApiTags('Finance - Sales')
@Controller('workspaces/:wsId/firms/:firmId/ewaybill')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'ewaybill_generation' })
export class EwaybillController {
  constructor(private readonly service: EwaybillService) {}

  /**
   * POST /workspaces/:wsId/firms/:firmId/ewaybill/:invoiceId/generate
   *
   * Generates an e-Way Bill for a posted invoice.
   * Respects Gujarat textile intrastate exemption (unless overrideExemption=true in body).
   * 180-day docDate guard applied server-side.
   */
  @Post(':invoiceId/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async generate(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: GenerateEwbDto,
    @CurrentUser() user: any,
  ) {
    // user._id ?? user.sub mirrors sale-invoice.controller - threads the actor to PostHog.
    const data = await this.service.generate(wsId, firmId, invoiceId, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/ewaybill/challan/:challanId/generate
   *
   * Generates an e-Way Bill for a posted delivery challan (the primary e-Way use case -
   * goods movement). Reuses the same transport DTO + guards as the invoice path. The
   * 3-segment path never collides with :invoiceId/generate. Cross-link:
   * EwaybillService.generateForChallan + DeliveryChallan schema ewayBill field.
   */
  @Post('challan/:challanId/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async generateForChallan(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('challanId') challanId: string,
    @Body() dto: GenerateEwbDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.service.generateForChallan(
      wsId,
      firmId,
      challanId,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data };
  }

  /**
   * PATCH /workspaces/:wsId/firms/:firmId/ewaybill/:invoiceId/extend
   *
   * Extends EWB validity. Only allowed within ±8h window of validUpto.
   * Throws 'EWB_EXTENSION_WINDOW' (400) if outside window.
   */
  @Patch(':invoiceId/extend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async extend(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: ExtendEwbDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.service.extend(wsId, firmId, invoiceId, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /**
   * POST /workspaces/:wsId/firms/:firmId/ewaybill/:invoiceId/cancel
   *
   * Cancels an active EWB within 24 hours of generation.
   * Throws 'EWB_CANCEL_WINDOW_EXPIRED' (400) if window has passed.
   */
  @Post(':invoiceId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, 'manage_gst_compliance' as any)
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: CancelEwbDto,
    @CurrentUser() user: any,
  ) {
    await this.service.cancel(
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
   * GET /workspaces/:wsId/firms/:firmId/ewaybill/expiring?hoursAhead=48
   *
   * Lists invoices with EWBs expiring within the next N hours (default: 48h).
   * Used by dashboard "EWBs expiring soon" alert panel.
   */
  @Get('expiring')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async listExpiring(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('hoursAhead') hoursAhead?: string,
  ) {
    const hours = hoursAhead ? parseInt(hoursAhead, 10) : 48;
    const data = await this.service.listExpiring(wsId, firmId, hours);
    return { success: true, data };
  }

  /**
   * GET /workspaces/:wsId/firms/:firmId/ewaybill/list?status=active|expiring|expired|cancelled&page=0&size=50
   *
   * Lists invoices filtered by EWB status with pagination.
   * Used by web UI tabs: Active / Expiring Soon / Expired / Cancelled.
   */
  @Get('list')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async listByStatus(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('status') status: 'active' | 'expiring' | 'expired' | 'cancelled' = 'active',
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
}
