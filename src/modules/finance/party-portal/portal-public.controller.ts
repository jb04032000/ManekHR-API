import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { PortalTokenGuard } from './portal-token.guard';
import { PortalThrottlerGuard } from './portal-throttler.guard';
import { PortalContext } from './decorators/portal-context.decorator';
import { PortalContext as PortalCtx } from './portal-token.service';
import { PortalPublicService } from './portal-public.service';
import { PortalPdfNonceService } from './portal-pdf-nonce.service';
import { SaleInvoicePrintService } from '../sales/sale-invoice/sale-invoice-print.service';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * Public portal endpoints (D-22, D-23, D-27).
 *
 * Marked @Public() so the global JwtAuthGuard skips them — auth flows entirely
 * through the X-Portal-Token header verified by PortalTokenGuard. Throttler
 * keyed by (jti, ip) at 60 req/min per D-27.
 *
 * Cross-party isolation: every read uses the partyId from the JWT
 * (req.portalContext.partyId), NEVER a path or body parameter (T-16-04-03).
 */
@ApiTags('Finance - Party Portal (public)')
@Controller('portal')
@Public()
@UseGuards(PortalTokenGuard, PortalThrottlerGuard)
@Throttle({ portal: { limit: 60, ttl: 60_000 } })
export class PortalPublicController {
  constructor(
    private readonly publicSvc: PortalPublicService,
    private readonly nonceSvc: PortalPdfNonceService,
    private readonly printSvc: SaleInvoicePrintService,
    private readonly audit: AuditService,
  ) {}

  @Get('context')
  context(@PortalContext() ctx: PortalCtx) {
    return this.publicSvc.getContext(ctx);
  }

  @Get('statement')
  statement(@PortalContext() ctx: PortalCtx) {
    return this.publicSvc.getStatementForParty(ctx);
  }

  @Get('invoices')
  invoices(
    @PortalContext() ctx: PortalCtx,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.publicSvc.getInvoicesForParty(ctx, +page, +limit);
  }

  @Get('invoices/:id/pdf-url')
  async pdfUrl(@PortalContext() ctx: PortalCtx, @Param('id') id: string) {
    // Cross-party assertion — invoice MUST belong to ctx.partyId.
    await this.publicSvc.assertInvoiceBelongsToParty(ctx, id);
    return this.nonceSvc.sign(id, ctx.partyId);
  }

  @Get('invoices/:id/pdf')
  async pdf(
    @PortalContext() ctx: PortalCtx,
    @Param('id') id: string,
    @Query('sig') sig: string,
    @Query('exp') exp: string,
    @Query('n') n: string,
    @Res() res: any,
  ) {
    const inv = await this.publicSvc.assertInvoiceBelongsToParty(ctx, id);
    await this.nonceSvc.consumeNonce(id, ctx.partyId, sig, exp, n);
    const buf = await this.printSvc.generatePdfBuffer(inv);
    res
      .setHeader('Content-Type', 'application/pdf')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="invoice-${inv.voucherNumber ?? id}.pdf"`,
      )
      .send(buf);
  }

  @Get('receipts')
  receipts(@PortalContext() ctx: PortalCtx) {
    return this.publicSvc.getReceiptsForParty(ctx);
  }

  @Get('aging')
  aging(@PortalContext() ctx: PortalCtx) {
    return this.publicSvc.getAgingForParty(ctx);
  }

  /** Page-view audit (fire-and-forget, never blocks portal latency). */
  @Post('page-view')
  @HttpCode(204)
  // require-await disabled: thin fire-and-forget handler - the audit write is voided
  // intentionally so the portal page-view never blocks on the log. No behavior change.
  // eslint-disable-next-line @typescript-eslint/require-await
  async pageView(@PortalContext() ctx: PortalCtx, @Body() body: { tab?: string }): Promise<void> {
    void this.audit
      .logEvent({
        workspaceId: ctx.wsId,
        module: AppModule.FINANCE,
        entityType: 'PortalAccessToken',
        entityId: ctx.partyId,
        action: 'PORTAL_PAGE_VIEW',
        actorId: ctx.partyId,
        actorNameSnapshot: 'portal-party',
        meta: { tab: body?.tab ?? 'unknown', jti: ctx.jti },
      })
      .catch(() => undefined);
    return;
  }
}
