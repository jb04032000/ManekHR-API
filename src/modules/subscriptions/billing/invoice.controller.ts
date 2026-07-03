import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { SubscriptionPayment } from './schemas/subscription-payment.schema';
import { InvoiceService } from './services/invoice.service';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve invoice access (D1f).
 *
 * Three routes:
 *   - `GET /api/subscriptions/payments/:id/invoice` — metadata only.
 *     Returns invoice number + generation timestamp + a download URL
 *     pointing back at the download route. 404 if not yet generated
 *     (background pipeline failed → POST regenerate to recover).
 *   - `GET /api/subscriptions/payments/:id/invoice/download` —
 *     auth-gated PDF stream proxied from R2. Invoice numbers are
 *     sequential per GST law, so direct R2 URLs would be enumerable;
 *     the proxy enforces user-owns-payment ACL.
 *   - `POST /api/subscriptions/payments/:id/invoice/regenerate` —
 *     idempotent for self-serve (returns existing if already
 *     generated). Useful when a transient pipeline failure left the
 *     invoice un-stamped.
 */
@LegacyUnclassified()
@Controller('subscriptions/payments')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class InvoiceController {
  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    private readonly invoices: InvoiceService,
  ) {}

  @Get(':id/invoice')
  async metadata(@Req() req: any, @Param('id') id: string) {
    const payment = await this.assertOwnedPayment(req.user.sub, id);
    if (!payment.invoiceNumber || !payment.invoicePdfUrl) {
      throw new NotFoundException('Invoice not yet generated for this payment');
    }
    return {
      paymentId: String(payment._id),
      invoiceNumber: payment.invoiceNumber,
      invoiceGeneratedAt: payment.invoiceGeneratedAt,
      downloadUrl: `/api/subscriptions/payments/${String(payment._id)}/invoice/download`,
      totalPaise: payment.totalPaise,
      capturedAt: payment.capturedAt,
    };
  }

  @Get(':id/invoice/download')
  async download(
    @Req() req: any,
    @Param('id') id: string,
    @Res({ passthrough: false }) res: Response,
  ) {
    await this.assertOwnedPayment(req.user.sub, id);
    const { invoiceNumber, pdf } = await this.invoices.download(id);
    res
      .status(200)
      .setHeader('Content-Type', 'application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`)
      .setHeader('Content-Length', String(pdf.length))
      .send(pdf);
  }

  @Post(':id/invoice/regenerate')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  async regenerate(@Req() req: any, @Param('id') id: string) {
    await this.assertOwnedPayment(req.user.sub, id);
    // Self-serve regenerate is non-forced — returns existing invoice
    // when one already exists. Admin route below uses force=true to
    // re-render after billing-profile corrections.
    return this.invoices.generate(id);
  }

  private async assertOwnedPayment(
    userId: string,
    paymentId: string,
  ): Promise<SubscriptionPayment> {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found');
    if (String(payment.userId) !== userId) {
      throw new ForbiddenException('Payment does not belong to this account');
    }
    return payment;
  }
}

/**
 * Admin invoice regenerate (D1f). Force=true so an admin can re-render
 * after correcting a customer's billing profile or platform legal
 * entity details. Re-uses the existing invoice number — GST law
 * forbids issuing a new number for the same supply.
 */
@LegacyUnclassified()
@Controller('admin/billing/payments')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class InvoiceAdminController {
  constructor(private readonly invoices: InvoiceService) {}

  @Post(':id/invoice/regenerate')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  async regenerate(@Param('id') id: string) {
    return this.invoices.generate(id, { force: true });
  }
}
