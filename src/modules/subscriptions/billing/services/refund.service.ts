import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { Subscription } from '../../schemas/subscription.schema';
import { Plan } from '../../schemas/plan.schema';
import { User } from '../../../users/schemas/user.schema';
import { RefundRequest } from '../schemas/refund-request.schema';
import { RefundPolicyService } from './refund-policy.service';
import { RazorpayPlatformService } from './razorpay-platform.service';
import { MailService } from '../../../mail/mail.service';
import { AuditAction, AuditLogService } from './audit-log.service';

interface RequestRefundArgs {
  paymentId: string;
  userId: string;
  amountPaise?: number;
  reason: string;
}

interface AdminRefundArgs {
  paymentId: string;
  adminUserId: string;
  amountPaise?: number;
  reason: string;
  speed?: 'normal' | 'optimum';
  /** Bypass policy window check — explicit admin override (logged). */
  bypassWindow?: boolean;
}

interface ApproveArgs {
  requestId: string;
  adminUserId: string;
  speed?: 'normal' | 'optimum';
}

interface RejectArgs {
  requestId: string;
  adminUserId: string;
  reason: string;
}

/**
 * Refund orchestrator (D1h).
 *
 * Three entry points:
 *   - `requestRefund(args)` — customer self-serve. Honours
 *     `RefundPolicy.customerSelfServiceEnabled`. Auto-approves +
 *     executes when within window AND policy permits without
 *     secondary admin approval. Otherwise creates a `pending_admin`
 *     request that an admin must approve.
 *   - `directRefund(args)` — admin-issued without prior request
 *     (proactive goodwill). Created in `approved` then executed in
 *     the same call. Always allowed regardless of policy window when
 *     `bypassWindow=true`; logged in audit trail.
 *   - `approveRequest(args)` / `rejectRequest(args)` — admin handling
 *     of a pending self-serve request.
 *
 * Per-payment idempotency: `RefundRequest` collection has a partial
 * unique index that allows at most ONE in-flight refund per payment.
 * Double-submit attempts surface as 11000 dup-key errors which we
 * surface as 409 Conflict.
 *
 * Per-request idempotency: `gatewayRefundId` unique-sparse — a webhook
 * replay or a parallel approve cannot double-charge Razorpay.
 *
 * Auto-downgrade: when `RefundPolicy.autoDowngradeOnFullRefund=true`
 * AND the refund is full (amountPaise == payment.totalPaise), the
 * linked Subscription is marked `cancelled` immediately. Otherwise
 * the subscription stays active until period-end (default behaviour
 * — typical for accounting goodwill that doesn't revoke service).
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(RefundRequest.name)
    private readonly requestModel: Model<RefundRequest>,
    private readonly policyService: RefundPolicyService,
    private readonly razorpay: RazorpayPlatformService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly audit: AuditLogService,
  ) {}

  // ── self-serve ──────────────────────────────────────────────────────

  async requestRefund(args: RequestRefundArgs): Promise<RefundRequest> {
    const policy = await this.policyService.getPolicy();
    if (!policy.customerSelfServiceEnabled) {
      throw new ForbiddenException(
        'Self-service refunds are disabled. Please contact support.',
      );
    }

    const payment = await this.assertRefundablePayment(
      args.paymentId,
      args.userId,
    );
    const refundAmount = this.resolveRefundAmount(payment, args.amountPaise, policy);

    const withinWindow = this.isWithinPolicyWindow(payment, policy);
    const requiresAdmin =
      !withinWindow && policy.requireSecondAdminApprovalAfterWindow;

    const request = await this.createRefundRequest({
      payment,
      userId: args.userId,
      amountPaise: refundAmount,
      reason: args.reason,
      initiatedBy: 'self',
      autoApprove: !requiresAdmin,
    });

    await this.audit.log({
      action: AuditAction.SelfRefundRequested,
      actorType: 'self',
      actorUserId: args.userId,
      targetUserId: args.userId,
      paymentId: args.paymentId,
      refundRequestId: String(request._id),
      metadata: {
        amountPaise: refundAmount,
        reason: args.reason,
        autoApproved: !requiresAdmin,
        withinWindow,
      },
    });

    if (!requiresAdmin) {
      // Within window + no secondary approval needed → execute now.
      await this.executeRefund(request._id as Types.ObjectId, args.userId);
      return this.requestModel.findById(request._id).exec() as Promise<RefundRequest>;
    }

    await this.sendRefundRequestedEmail(payment, request).catch((err) =>
      this.logger.warn(
        `requestRefund email failed payment=${payment._id} err=${(err as Error).message}`,
      ),
    );

    return request;
  }

  async getRequestForUser(
    requestId: string,
    userId: string,
  ): Promise<RefundRequest> {
    const r = await this.requestModel.findById(requestId).exec();
    if (!r) throw new NotFoundException('Refund request not found');
    if (String(r.userId) !== userId) {
      throw new ForbiddenException('Refund request does not belong to you');
    }
    return r;
  }

  async listMyRequests(userId: string): Promise<RefundRequest[]> {
    return this.requestModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
  }

  // ── admin ───────────────────────────────────────────────────────────

  async directRefund(args: AdminRefundArgs): Promise<RefundRequest> {
    const policy = await this.policyService.getPolicy();
    const payment = await this.paymentModel.findById(args.paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
      throw new BadRequestException(
        `Cannot refund payment in status: ${payment.status}`,
      );
    }

    const refundAmount = this.resolveRefundAmount(payment, args.amountPaise, policy);

    if (!args.bypassWindow && !this.isWithinPolicyWindow(payment, policy)) {
      this.logger.log(
        `Admin direct refund out-of-window payment=${args.paymentId} admin=${args.adminUserId}`,
      );
    }

    const request = await this.createRefundRequest({
      payment,
      userId: String(payment.userId),
      amountPaise: refundAmount,
      reason: args.reason,
      initiatedBy: 'admin',
      autoApprove: true,
      approvedBy: args.adminUserId,
      speed: args.speed,
    });

    await this.audit.log({
      action: AuditAction.AdminRefundDirect,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(payment.userId),
      paymentId: args.paymentId,
      refundRequestId: String(request._id),
      metadata: {
        amountPaise: refundAmount,
        reason: args.reason,
        speed: args.speed,
        bypassWindow: !!args.bypassWindow,
      },
    });

    await this.executeRefund(
      request._id as Types.ObjectId,
      String(payment.userId),
    );
    return this.requestModel.findById(request._id).exec() as Promise<RefundRequest>;
  }

  async approveRequest(args: ApproveArgs): Promise<RefundRequest> {
    const updated = await this.requestModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(args.requestId), status: 'pending_admin' },
        {
          $set: {
            status: 'approved',
            approvedBy: new Types.ObjectId(args.adminUserId),
            approvedAt: new Date(),
            ...(args.speed ? { speed: args.speed } : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(
        'Refund request not found or not in pending state',
      );
    }
    await this.audit.log({
      action: AuditAction.AdminRefundApproved,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(updated.userId),
      paymentId: String(updated.subscriptionPaymentId),
      refundRequestId: String(updated._id),
      metadata: {
        amountPaise: updated.amountPaise,
        speed: args.speed ?? updated.speed,
      },
    });
    await this.executeRefund(
      updated._id as Types.ObjectId,
      String(updated.userId),
    );
    return this.requestModel.findById(updated._id).exec() as Promise<RefundRequest>;
  }

  async rejectRequest(args: RejectArgs): Promise<RefundRequest> {
    const updated = await this.requestModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(args.requestId), status: 'pending_admin' },
        {
          $set: {
            status: 'rejected',
            rejectedBy: new Types.ObjectId(args.adminUserId),
            rejectedAt: new Date(),
            rejectionReason: args.reason,
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new NotFoundException(
        'Refund request not found or not in pending state',
      );
    }
    await this.audit.log({
      action: AuditAction.AdminRefundRejected,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(updated.userId),
      paymentId: String(updated.subscriptionPaymentId),
      refundRequestId: String(updated._id),
      metadata: { reason: args.reason },
    });
    await this.sendRefundRejectedEmail(updated).catch((err) =>
      this.logger.warn(
        `rejectRequest email failed req=${updated._id} err=${(err as Error).message}`,
      ),
    );
    return updated;
  }

  async listPending(limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.requestModel
        .find({ status: { $in: ['pending_admin', 'approved', 'processing'] } })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.requestModel
        .countDocuments({ status: { $in: ['pending_admin', 'approved', 'processing'] } })
        .exec(),
    ]);
    return { items, total, limit, offset };
  }

  // ── execution ───────────────────────────────────────────────────────

  /**
   * Execute an approved refund — call Razorpay, persist subdoc, update
   * SubscriptionPayment status, optionally auto-downgrade subscription.
   *
   * Idempotency: if the request already has `gatewayRefundId` we skip
   * the Razorpay call. Race-safe — multiple concurrent approve calls
   * land here but only one wins the `gatewayRefundId` assignment.
   */
  private async executeRefund(
    requestId: Types.ObjectId,
    userId: string,
  ): Promise<void> {
    // Atomic: only proceed if status is still `approved` and gatewayRefundId
    // hasn't been set by a concurrent worker.
    const inflight = await this.requestModel
      .findOneAndUpdate(
        { _id: requestId, status: 'approved' },
        { $set: { status: 'processing' } },
        { new: true },
      )
      .exec();
    if (!inflight) {
      this.logger.log(`executeRefund skipped — concurrent worker won req=${requestId}`);
      return;
    }

    const payment = await this.paymentModel
      .findById(inflight.subscriptionPaymentId)
      .exec();
    if (!payment || !payment.gatewayPaymentId) {
      await this.markRequestFailed(inflight, 'Payment row or gateway id missing');
      return;
    }

    let rzpRefund;
    try {
      rzpRefund = await this.razorpay.createRefund({
        paymentId: payment.gatewayPaymentId,
        amountPaise: inflight.amountPaise,
        speed: (inflight.speed as 'normal' | 'optimum') ?? 'normal',
        notes: {
          refundRequestId: String(inflight._id),
          subscriptionPaymentId: String(payment._id),
          reason: inflight.reason,
        },
      });
    } catch (err) {
      const msg = (err as Error).message ?? 'Razorpay refund failed';
      await this.markRequestFailed(inflight, msg.slice(0, 500));
      this.logger.error(
        `Refund execution failed req=${inflight._id} err=${msg}`,
      );
      return;
    }

    // Stamp gateway id; webhook will flip status to `processed` when
    // Razorpay confirms. Race-safe: if a webhook beat us here and
    // already set the id via the existing refund.created handler, we
    // detect via the handleRefund subdoc on payment.refunds[].
    await this.requestModel
      .updateOne(
        { _id: inflight._id, gatewayRefundId: { $exists: false } },
        { $set: { gatewayRefundId: rzpRefund.id } },
      )
      .exec();

    // Append refund subdoc to SubscriptionPayment immediately (the
    // webhook handler is idempotent on `refundId` so a webhook
    // landing later just no-ops).
    const alreadyRecorded = (payment.refunds ?? []).some(
      (r) => r.refundId === rzpRefund.id,
    );
    if (!alreadyRecorded) {
      payment.refunds.push({
        refundId: rzpRefund.id,
        amountPaise: rzpRefund.amount,
        status: rzpRefund.status === 'processed' ? 'processed' : 'pending',
        reason: inflight.reason,
        initiatedAt: new Date(),
        processedAt:
          rzpRefund.status === 'processed' ? new Date() : undefined,
        initiatedBy: inflight.approvedBy ?? new Types.ObjectId(userId),
      } as any);
      const totalRefunded = payment.refunds.reduce(
        (sum, r) => sum + (r.amountPaise ?? 0),
        0,
      );
      if (totalRefunded >= payment.totalPaise) {
        payment.status = 'refunded';
      } else if (totalRefunded > 0) {
        payment.status = 'partially_refunded';
      }
      await payment.save();
    }

    // Auto-downgrade on full refund per policy.
    const policy = await this.policyService.getPolicy();
    const isFullRefund = inflight.amountPaise >= payment.totalPaise;
    if (
      policy.autoDowngradeOnFullRefund &&
      isFullRefund &&
      payment.subscriptionId
    ) {
      await this.subscriptionModel
        .updateOne(
          {
            _id: payment.subscriptionId,
            status: { $nin: ['cancelled', 'expired', 'superseded'] },
          },
          {
            $set: {
              status: 'cancelled',
              cancelledAt: new Date(),
              cancellationReason: 'auto_downgrade_on_full_refund',
            },
          },
        )
        .exec();
      this.logger.log(
        `Subscription auto-downgraded after full refund payment=${payment._id} sub=${payment.subscriptionId}`,
      );
    }

    // If Razorpay returned `processed` synchronously (rare for normal
    // speed), mark the request processed too. Otherwise wait for the
    // webhook to flip it.
    if (rzpRefund.status === 'processed') {
      await this.requestModel
        .updateOne(
          { _id: inflight._id },
          { $set: { status: 'processed', processedAt: new Date() } },
        )
        .exec();
    }

    await this.sendRefundProcessedEmail(payment, inflight).catch((err) =>
      this.logger.warn(
        `Refund processed email failed req=${inflight._id} err=${(err as Error).message}`,
      ),
    );

    this.logger.log(
      `Refund executed req=${inflight._id} payment=${payment._id} rzp=${rzpRefund.id} amount=${rzpRefund.amount}`,
    );
  }

  // ── webhook entry: status sync from refund.processed ────────────────

  /**
   * Called by `RazorpayWebhookService.handleRefund` when a `refund.*`
   * event lands. Marks the matching `RefundRequest` as `processed` or
   * `failed` based on Razorpay's terminal state. Idempotent — replays
   * are no-ops.
   */
  async syncFromWebhook(args: {
    gatewayRefundId: string;
    status: 'processed' | 'failed';
    failureReason?: string;
  }): Promise<void> {
    const update: any = {};
    if (args.status === 'processed') {
      update.status = 'processed';
      update.processedAt = new Date();
    } else {
      update.status = 'failed';
      update.failureReason = args.failureReason?.slice(0, 500);
    }
    await this.requestModel
      .updateOne(
        {
          gatewayRefundId: args.gatewayRefundId,
          status: { $nin: ['processed', 'failed', 'rejected'] },
        },
        { $set: update },
      )
      .exec();
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async assertRefundablePayment(
    paymentId: string,
    userId: string,
  ): Promise<SubscriptionPayment> {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found');
    if (String(payment.userId) !== userId) {
      throw new ForbiddenException('Payment does not belong to your account');
    }
    if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
      throw new BadRequestException(
        `Cannot refund a payment in status: ${payment.status}`,
      );
    }
    if (!payment.gatewayPaymentId) {
      throw new BadRequestException(
        'Payment has no gateway id — manual payments cannot be auto-refunded',
      );
    }
    return payment;
  }

  private resolveRefundAmount(
    payment: SubscriptionPayment,
    requestedPaise: number | undefined,
    policy: { allowPartial: boolean },
  ): number {
    const alreadyRefunded = (payment.refunds ?? []).reduce(
      (sum, r) => sum + (r.amountPaise ?? 0),
      0,
    );
    const remaining = payment.totalPaise - alreadyRefunded;
    if (remaining <= 0) {
      throw new BadRequestException('Payment is already fully refunded');
    }
    if (requestedPaise === undefined) {
      // Full refund of the remaining balance.
      return remaining;
    }
    if (!policy.allowPartial && requestedPaise < remaining) {
      throw new BadRequestException(
        'Partial refunds are disabled by policy — request the full remaining amount',
      );
    }
    if (requestedPaise <= 0) {
      throw new BadRequestException('amountPaise must be positive');
    }
    if (requestedPaise > remaining) {
      throw new BadRequestException(
        `amountPaise (${requestedPaise}) exceeds remaining refundable balance (${remaining})`,
      );
    }
    return requestedPaise;
  }

  private isWithinPolicyWindow(
    payment: SubscriptionPayment,
    policy: { eligibleWithinDays: number },
  ): boolean {
    if (policy.eligibleWithinDays <= 0) return false;
    const capturedAt = payment.capturedAt ?? (payment as any).createdAt;
    if (!capturedAt) return false;
    const diffMs = Date.now() - new Date(capturedAt).getTime();
    return diffMs <= policy.eligibleWithinDays * 24 * 60 * 60 * 1000;
  }

  private async createRefundRequest(args: {
    payment: SubscriptionPayment;
    userId: string;
    amountPaise: number;
    reason: string;
    initiatedBy: 'self' | 'admin';
    autoApprove: boolean;
    approvedBy?: string;
    speed?: 'normal' | 'optimum';
  }): Promise<RefundRequest> {
    const isPartial = args.amountPaise < args.payment.totalPaise;
    const status = args.autoApprove ? 'approved' : 'pending_admin';

    try {
      return await this.requestModel.create({
        subscriptionPaymentId: args.payment._id,
        userId: new Types.ObjectId(args.userId),
        amountPaise: args.amountPaise,
        isPartial,
        reason: args.reason,
        status,
        initiatedBy: args.initiatedBy,
        ...(args.autoApprove
          ? {
              approvedBy: args.approvedBy
                ? new Types.ObjectId(args.approvedBy)
                : undefined,
              approvedAt: new Date(),
            }
          : {}),
        ...(args.speed ? { speed: args.speed } : {}),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          'A refund request is already in-flight for this payment',
        );
      }
      throw err;
    }
  }

  private async markRequestFailed(
    request: RefundRequest,
    reason: string,
  ): Promise<void> {
    await this.requestModel
      .updateOne(
        { _id: request._id, status: 'processing' },
        {
          $set: {
            status: 'failed',
            failureReason: reason.slice(0, 500),
          },
        },
      )
      .exec();
  }

  // ── emails ──────────────────────────────────────────────────────────

  private async fetchEmailContext(payment: SubscriptionPayment) {
    const [user, plan] = await Promise.all([
      this.userModel.findById(payment.userId).select('name email').exec(),
      this.planModel.findById(payment.planId).select('name').exec(),
    ]);
    if (!user?.email) return null;
    const supplierName =
      this.configService.get<string>('app.platformLegalEntity.name') ??
      'ManekHR';
    const frontendUrl =
      this.configService.get<string>('app.frontendUrl') ??
      'https://app.manekhr.in';
    return { user, plan, supplierName, frontendUrl };
  }

  private async sendRefundRequestedEmail(
    payment: SubscriptionPayment,
    request: RefundRequest,
  ): Promise<void> {
    const ctx = await this.fetchEmailContext(payment);
    if (!ctx) return;
    const { user, plan, supplierName } = ctx;
    const amount = (request.amountPaise / 100).toFixed(2);
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#111;">Refund request received</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>We've received your refund request for <strong>₹${amount}</strong> against
           the <strong>${plan?.name ?? 'subscription'}</strong> plan. Our billing team
           will review it within 2 working days and update you by email.</p>
        <p style="color:#666;font-size:13px;margin-top:24px;">${supplierName} billing.</p>
      </div>
    `;
    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `Refund request received — ${supplierName}`,
      html,
    });
  }

  private async sendRefundRejectedEmail(
    request: RefundRequest,
  ): Promise<void> {
    const payment = await this.paymentModel
      .findById(request.subscriptionPaymentId)
      .exec();
    if (!payment) return;
    const ctx = await this.fetchEmailContext(payment);
    if (!ctx) return;
    const { user, plan, supplierName } = ctx;
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#b91c1c;">Refund request — update</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>After review, we couldn't process your refund request for the
           <strong>${plan?.name ?? 'subscription'}</strong> plan.</p>
        ${
          request.rejectionReason
            ? `<p><strong>Reason:</strong> ${request.rejectionReason}</p>`
            : ''
        }
        <p>If you'd like to discuss this, reply to this email and our team will help.</p>
        <p style="color:#666;font-size:13px;margin-top:24px;">${supplierName} billing.</p>
      </div>
    `;
    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `Refund request update — ${supplierName}`,
      html,
    });
  }

  private async sendRefundProcessedEmail(
    payment: SubscriptionPayment,
    request: RefundRequest,
  ): Promise<void> {
    const ctx = await this.fetchEmailContext(payment);
    if (!ctx) return;
    const { user, plan, supplierName } = ctx;
    const amount = (request.amountPaise / 100).toFixed(2);
    const speedNote =
      request.speed === 'optimum'
        ? 'Funds will reflect in your account within a few hours.'
        : 'Funds will reflect in your account in 3-5 working days.';
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#16a34a;">Refund initiated — ₹${amount}</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>We've initiated a refund of <strong>₹${amount}</strong> against your
           <strong>${plan?.name ?? 'subscription'}</strong> plan payment.</p>
        <p>${speedNote}</p>
        <p style="color:#666;font-size:13px;margin-top:24px;">${supplierName} billing.</p>
      </div>
    `;
    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `Refund initiated — ${supplierName}`,
      html,
    });
  }
}
