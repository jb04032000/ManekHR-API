import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Plan } from '../../schemas/plan.schema';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { User } from '../../../users/schemas/user.schema';
import { PricingService } from './pricing.service';
import { RazorpayPlatformService } from './razorpay-platform.service';
import { InvoiceService } from './invoice.service';
import { AuditAction, AuditLogService } from './audit-log.service';

interface IssueArgs {
  adminUserId: string;
  userId: string;
  planId: string;
  billingCycle: 'monthly' | 'yearly';
  /**
   * Optional override for the negotiated total (paise, GST-inclusive).
   * Omit to use the plan's standard quote.
   */
  amountOverridePaise?: number;
  /** Internal note — surfaces in admin link list + Razorpay notes. */
  reason?: string;
  /** Link expiry in seconds from now. Default 7 days. */
  expireInSeconds?: number;
}

interface IssueResult {
  paymentId: string;
  shortUrl: string;
  razorpayPaymentLinkId: string;
  amountPaise: number;
}

/**
 * Admin payment-link issuance (D1i).
 *
 * Flow:
 *   1. Validate user + plan + amount override (must be > 0).
 *   2. Snapshot billing profile onto a `SubscriptionPayment` row in
 *      `created` state with `paymentMode='one_time'`,
 *      `gateway='razorpay'`. The row carries the negotiated price so
 *      the invoice on capture renders the right amount.
 *   3. Call Razorpay `paymentLink.create` with `notes` carrying the
 *      local payment row id. Stamp `gatewayPaymentLinkId` onto the row.
 *   4. Return short_url for admin to share with customer.
 *
 * On payment: `payment_link.paid` webhook (D1d/D1i) round-trips back
 * to the row via `gatewayPaymentLinkId`, captures it, creates the
 * Subscription with `source='paid_link'`, fires invoice generation.
 */
@Injectable()
export class AdminPaymentLinkService {
  private readonly logger = new Logger(AdminPaymentLinkService.name);
  private static readonly DEFAULT_EXPIRY_SECONDS = 7 * 24 * 3600;

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    private readonly pricing: PricingService,
    private readonly razorpay: RazorpayPlatformService,
    private readonly audit: AuditLogService,
  ) {}

  async issuePaymentLink(args: IssueArgs): Promise<IssueResult> {
    const plan = await this.planModel.findById(args.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isActive) {
      throw new BadRequestException('Plan is not active');
    }

    const user = await this.userModel
      .findById(args.userId)
      .select('name email mobile billingProfile')
      .exec();
    if (!user) throw new NotFoundException('User not found');

    // Compute the standard quote first; coupon application not
    // available on admin-issued links (admin can simply set the
    // negotiated price via amountOverridePaise).
    const baseQuote = this.pricing.computeQuote(plan, args.billingCycle);

    // Final price: override or standard total.
    const finalAmountPaise =
      args.amountOverridePaise !== undefined
        ? args.amountOverridePaise
        : baseQuote.totalPaise;
    if (finalAmountPaise <= 0) {
      throw new BadRequestException('amountOverridePaise must be > 0');
    }

    // Re-quote at the override so GST breakdown reflects the
    // negotiated total (treated as fixed-price override → reverse
    // GST compute from the final).
    const negotiatedQuote =
      args.amountOverridePaise !== undefined
        ? this.pricing.computeQuote(plan, args.billingCycle, {
            finalTotalOverridePaise: finalAmountPaise,
          })
        : baseQuote;

    const billingSnapshot = InvoiceService.buildBillingSnapshot(user.toObject());
    const expireBy =
      Math.floor(Date.now() / 1000) +
      (args.expireInSeconds ?? AdminPaymentLinkService.DEFAULT_EXPIRY_SECONDS);

    // Persist seed payment row FIRST so the link's notes can carry
    // its id. status='created' until payment_link.paid webhook fires.
    const seed = await this.paymentModel.create({
      userId: new Types.ObjectId(args.userId),
      planId: new Types.ObjectId(args.planId),
      billingCycle: args.billingCycle,
      paymentMode: 'one_time',
      status: 'created',
      gateway: 'razorpay',
      planPricePaise: negotiatedQuote.basePricePaise,
      discountPaise: negotiatedQuote.discountPaise,
      gstPaise: negotiatedQuote.gstPaise,
      totalPaise: negotiatedQuote.totalPaise,
      gstRatePercent: negotiatedQuote.gstRatePercent,
      billingSnapshot,
    });

    const link = await this.razorpay.createPaymentLink({
      amountPaise: finalAmountPaise,
      description: `${plan.name} (${args.billingCycle}) — ${args.reason ?? 'Admin issued'}`,
      customer: {
        name: user.name,
        email: user.email,
        contact: user.mobile,
      },
      referenceId: String(seed._id),
      expireBySeconds: expireBy,
      notifyEmail: !!user.email,
      notifySms: !!user.mobile,
      notes: {
        subscriptionPaymentId: String(seed._id),
        userId: args.userId,
        planId: args.planId,
        billingCycle: args.billingCycle,
        adminUserId: args.adminUserId,
        ...(args.reason ? { reason: args.reason } : {}),
      },
    });

    await this.paymentModel
      .updateOne(
        { _id: seed._id },
        { $set: { gatewayPaymentLinkId: link.id } },
      )
      .exec();

    this.logger.log(
      `Payment link issued admin=${args.adminUserId} user=${args.userId} plan=${args.planId} amount=${finalAmountPaise} link=${link.id}`,
    );
    await this.audit.log({
      action: AuditAction.AdminPaymentLinkIssued,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: args.userId,
      paymentId: String(seed._id),
      planId: args.planId,
      metadata: {
        amountPaise: finalAmountPaise,
        amountOverridden: args.amountOverridePaise !== undefined,
        razorpayPaymentLinkId: link.id,
        shortUrl: link.shortUrl,
        billingCycle: args.billingCycle,
        reason: args.reason,
      },
    });

    return {
      paymentId: String(seed._id),
      shortUrl: link.shortUrl,
      razorpayPaymentLinkId: link.id,
      amountPaise: finalAmountPaise,
    };
  }

  async cancelPaymentLink(
    paymentId: string,
    adminUserId?: string,
  ): Promise<{ id: string; status: string }> {
    const seed = await this.paymentModel.findById(paymentId).exec();
    if (!seed) throw new NotFoundException('Payment row not found');
    if (!seed.gatewayPaymentLinkId) {
      throw new BadRequestException('Payment row has no payment-link id');
    }
    if (seed.status !== 'created') {
      throw new BadRequestException(
        `Cannot cancel link for payment in status: ${seed.status}`,
      );
    }
    const result = await this.razorpay.cancelPaymentLink(
      seed.gatewayPaymentLinkId,
    );
    // Local row will be flipped by the payment_link.cancelled webhook;
    // also flip optimistically so admin UI reflects immediately.
    await this.paymentModel
      .updateOne(
        { _id: seed._id, status: 'created' },
        {
          $set: {
            status: 'failed',
            failureReason: 'admin_cancelled',
            failedAt: new Date(),
          },
        },
      )
      .exec();
    await this.audit.log({
      action: AuditAction.AdminPaymentLinkCancelled,
      actorType: 'admin',
      actorUserId: adminUserId,
      targetUserId: String(seed.userId),
      paymentId: String(seed._id),
      metadata: {
        razorpayPaymentLinkId: seed.gatewayPaymentLinkId,
        gatewayStatus: result.status,
      },
    });
    return result;
  }

  async listPaymentLinks(args: {
    userId?: string;
    status?: 'created' | 'captured' | 'failed';
    limit?: number;
    offset?: number;
  }) {
    const filter: any = {
      gatewayPaymentLinkId: { $exists: true, $ne: null },
    };
    if (args.userId) filter.userId = new Types.ObjectId(args.userId);
    if (args.status) filter.status = args.status;
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const [items, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.paymentModel.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, offset };
  }
}
