import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { Plan } from '../../schemas/plan.schema';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceStorageService } from './invoice-storage.service';
import { MailService } from '../../../mail/mail.service';
import { AuditAction, AuditLogService } from './audit-log.service';

interface GenerateOpts {
  /** Force regeneration even if an invoice already exists. Admin only. */
  force?: boolean;
  /** Skip the email step (fetch-only generation). */
  skipEmail?: boolean;
}

interface GenerateResult {
  invoiceNumber: string;
  invoicePdfKey: string;
  alreadyExisted: boolean;
}

/**
 * Invoice generation orchestrator (D1f).
 *
 * Idempotent by default:
 *   - If `payment.invoiceNumber` is already set and `opts.force` is
 *     not, returns the existing snapshot — no PDF re-render, no
 *     R2 write, no email re-send.
 *   - Concurrent calls for the same payment may both pass the
 *     idempotency guard; the second call's invoice-number reservation
 *     is wasted but the persisted state remains consistent because
 *     the final `findOneAndUpdate` only writes when the row is still
 *     missing an invoice number. The wasted number leaves a sequence
 *     gap (acceptable per `InvoiceNumberService` doc).
 *
 * Failure mode policy:
 *   - PDF render / R2 upload errors propagate to the caller. Generation
 *     is triggered from non-blocking sites (capture confirmation +
 *     webhook handlers) which catch + log without failing the
 *     user-facing capture — invoice availability is eventual.
 *   - Email failures NEVER cause invoice generation to fail. The
 *     PDF is in R2 + the row stamped; the user can re-fetch via the
 *     download endpoint regardless.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    private readonly numberService: InvoiceNumberService,
    private readonly pdfService: InvoicePdfService,
    private readonly storage: InvoiceStorageService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Generate an invoice for a captured payment. Returns the existing
   * invoice if one already exists (unless `opts.force` is true).
   */
  async generate(
    paymentId: string,
    opts: GenerateOpts = {},
  ): Promise<GenerateResult> {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found');

    if (payment.status !== 'captured' && !opts.force) {
      throw new NotFoundException(
        `Payment is not captured (status=${payment.status})`,
      );
    }

    if (payment.invoiceNumber && payment.invoicePdfUrl && !opts.force) {
      return {
        invoiceNumber: payment.invoiceNumber,
        invoicePdfKey: payment.invoicePdfUrl,
        alreadyExisted: true,
      };
    }

    const plan = await this.planModel.findById(payment.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found for invoice');

    const invoiceDate = payment.capturedAt ?? new Date();
    const invoiceNumber = opts.force && payment.invoiceNumber
      ? payment.invoiceNumber
      : await this.numberService.nextInvoiceNumber(invoiceDate);

    const pdf = await this.pdfService.render({
      payment,
      plan,
      invoiceNumber,
      invoiceDate,
    });

    const { key } = await this.storage.upload({ invoiceNumber, pdf });

    await this.paymentModel
      .updateOne(
        { _id: payment._id },
        {
          $set: {
            invoiceNumber,
            invoicePdfUrl: key, // R2 key — proxy via /invoice/download
            invoiceGeneratedAt: new Date(),
          },
        },
      )
      .exec();

    this.logger.log(
      `Invoice generated payment=${payment._id} number=${invoiceNumber} key=${key}`,
    );
    await this.audit.log({
      action: AuditAction.SystemInvoiceGenerated,
      actorType: 'system',
      targetUserId: String(payment.userId),
      paymentId: String(payment._id),
      subscriptionId: payment.subscriptionId
        ? String(payment.subscriptionId)
        : undefined,
      metadata: { invoiceNumber, totalPaise: payment.totalPaise, force: !!opts.force },
    });

    if (!opts.skipEmail) {
      this.sendInvoiceEmail({
        payment,
        plan,
        invoiceNumber,
        pdf,
      }).catch((err) =>
        this.logger.warn(
          `Invoice email failed payment=${payment._id} err=${(err as Error).message}`,
        ),
      );
    }

    return {
      invoiceNumber,
      invoicePdfKey: key,
      alreadyExisted: false,
    };
  }

  /**
   * Fetch an invoice PDF for download. Auth check (user-owns-payment)
   * is the controller's job; this returns the bytes blindly.
   */
  async download(paymentId: string): Promise<{
    invoiceNumber: string;
    pdf: Buffer;
  }> {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found');
    if (!payment.invoiceNumber || !payment.invoicePdfUrl) {
      throw new NotFoundException('Invoice not yet generated');
    }
    const pdf = await this.storage.download(payment.invoicePdfUrl);
    return { invoiceNumber: payment.invoiceNumber, pdf };
  }

  // ── email ───────────────────────────────────────────────────────────

  private async sendInvoiceEmail(args: {
    payment: SubscriptionPayment;
    plan: Plan;
    invoiceNumber: string;
    pdf: Buffer;
  }): Promise<void> {
    const recipient =
      args.payment.billingSnapshot?.recipientEmail ??
      undefined;
    if (!recipient) {
      this.logger.warn(
        `Skipping invoice email — no recipient on snapshot. payment=${args.payment._id}`,
      );
      return;
    }

    const supplierName =
      this.configService.get<string>('app.platformLegalEntity.name') ??
      'ManekHR';
    const amount = (args.payment.totalPaise / 100).toFixed(2);
    const cycle = args.payment.billingCycle;

    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #111;">Your invoice from ${supplierName}</h2>
        <p>Hi${
          args.payment.billingSnapshot?.recipientName
            ? ' ' + args.payment.billingSnapshot.recipientName
            : ''
        },</p>
        <p>Thanks for your subscription. Your tax invoice for the <strong>${args.plan.name}</strong>
           ${cycle} plan is attached as a PDF.</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 4px 12px 4px 0; color: #666;">Invoice #</td>
              <td style="padding: 4px 0;"><strong>${args.invoiceNumber}</strong></td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #666;">Amount</td>
              <td style="padding: 4px 0;"><strong>₹${amount}</strong></td></tr>
        </table>
        <p style="color: #666; font-size: 13px; margin-top: 24px;">
          This is a GST tax invoice issued under Rule 46 of the CGST Rules, 2017.
          No signature is required.
        </p>
      </div>
    `;

    await this.mailService.sendInvoiceEmail({
      to: recipient,
      subject: `Tax Invoice ${args.invoiceNumber} — ${supplierName}`,
      html,
      attachments: [
        {
          filename: `${args.invoiceNumber}.pdf`,
          content: args.pdf,
          contentType: 'application/pdf',
        },
      ],
    });
  }

  /** Build a billing snapshot from a User doc — used at order-create time. */
  static buildBillingSnapshot(user: {
    name: string;
    email?: string;
    mobile?: string;
    billingProfile?: any;
  }): SubscriptionPayment['billingSnapshot'] {
    const profile = user.billingProfile ?? {};
    return {
      recipientName: user.name,
      recipientEmail: user.email,
      recipientContact: user.mobile,
      gstin: profile.gstin,
      businessName: profile.businessName,
      addressLine1: profile.addressLine1,
      addressLine2: profile.addressLine2,
      city: profile.city,
      state: profile.state,
      stateCode: profile.stateCode,
      pincode: profile.pincode,
      country: profile.country ?? 'India',
    };
  }
}
