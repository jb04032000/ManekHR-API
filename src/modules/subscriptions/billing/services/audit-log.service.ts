import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BillingAuditEvent } from '../schemas/billing-audit-event.schema';

/**
 * Action-name constants. Convention: `<actorType>.<verb>[_<noun>]`.
 *
 * Adding a new action: add a constant here so callers don't typo
 * action names. Schema accepts any string — constants are convention,
 * not enforcement.
 */
export const AuditAction = {
  // ── admin actions ───────────────────────────────────────────────
  AdminGrant: 'admin.grant',
  AdminExtendPeriod: 'admin.extend_period',
  AdminEntitlementOverride: 'admin.entitlement_override',
  AdminPause: 'admin.pause_subscription',
  AdminResume: 'admin.resume_subscription',
  AdminForceCancel: 'admin.force_cancel',
  AdminManualPayment: 'admin.manual_payment',
  AdminPaymentLinkIssued: 'admin.payment_link_issued',
  AdminPaymentLinkCancelled: 'admin.payment_link_cancelled',
  AdminCustomPlanCreated: 'admin.custom_plan_created',
  AdminCustomPlanUpdated: 'admin.custom_plan_updated',
  AdminCustomPlanArchived: 'admin.custom_plan_archived',
  AdminRefundDirect: 'admin.refund_direct',
  AdminRefundApproved: 'admin.refund_approved',
  AdminRefundRejected: 'admin.refund_rejected',
  AdminCouponCreated: 'admin.coupon_created',
  AdminCouponUpdated: 'admin.coupon_updated',
  AdminCouponArchived: 'admin.coupon_archived',
  AdminBillingPolicyUpdated: 'admin.billing_policy_updated',
  AdminRefundPolicyUpdated: 'admin.refund_policy_updated',

  // ── self-serve customer actions ─────────────────────────────────
  SelfCheckoutOrderCreated: 'self.checkout_order_created',
  SelfCheckoutConfirmed: 'self.checkout_confirmed',
  SelfMandateCreated: 'self.mandate_created',
  SelfMandateCancelled: 'self.mandate_cancelled',
  SelfMandatePaused: 'self.mandate_paused',
  SelfMandateResumed: 'self.mandate_resumed',
  SelfRefundRequested: 'self.refund_requested',
  SelfBillingProfileUpdated: 'self.billing_profile_updated',
  // Task 4 — customer-facing change-plan flow.
  SelfPlanChangeInitiated: 'self.plan_change_initiated',
  SelfPlanChangeApplied: 'self.plan_change_applied',
  SelfPlanChangeScheduled: 'self.plan_change_scheduled',

  // ── system actions ──────────────────────────────────────────────
  SystemDunningGraceEntered: 'system.dunning_grace_entered',
  SystemDunningGraceExpired: 'system.dunning_grace_expired',
  SystemDunningRecovered: 'system.dunning_recovered',
  SystemInvoiceGenerated: 'system.invoice_generated',
  SystemAutoDowngrade: 'system.auto_downgrade_full_refund',
  // D4 — marketing automation
  SystemMarketingTrialReminderSent: 'system.marketing_trial_reminder_sent',
  // Post-expiry "you're now on Free" notice, fired from downgradeToBasePlan.
  SystemMarketingTrialEndedSent: 'system.marketing_trial_ended_sent',
  SystemMarketingRenewalNoticeSent: 'system.marketing_renewal_notice_sent',
  SystemMarketingWinBackSent: 'system.marketing_win_back_sent',
  SystemMarketingAbandonedCheckoutSent: 'system.marketing_abandoned_checkout_sent',

  // ── webhook actions ─────────────────────────────────────────────
  WebhookPaymentCaptured: 'webhook.payment_captured',
  WebhookPaymentFailed: 'webhook.payment_failed',
  WebhookSubscriptionActivated: 'webhook.subscription_activated',
  WebhookSubscriptionCharged: 'webhook.subscription_charged',
  WebhookSubscriptionHalted: 'webhook.subscription_halted',
  WebhookSubscriptionCancelled: 'webhook.subscription_cancelled',
  WebhookSubscriptionPaused: 'webhook.subscription_paused',
  WebhookSubscriptionResumed: 'webhook.subscription_resumed',
  WebhookRefundProcessed: 'webhook.refund_processed',
  WebhookRefundFailed: 'webhook.refund_failed',
  WebhookPaymentLinkPaid: 'webhook.payment_link_paid',
} as const;

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

interface LogEventArgs {
  action: string;
  actorType: 'admin' | 'self' | 'system' | 'webhook';
  actorUserId?: string | Types.ObjectId;
  targetUserId?: string | Types.ObjectId;
  subscriptionId?: string | Types.ObjectId;
  paymentId?: string | Types.ObjectId;
  refundRequestId?: string | Types.ObjectId;
  planId?: string | Types.ObjectId;
  couponId?: string | Types.ObjectId;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

interface QueryEventsArgs {
  actorUserId?: string;
  targetUserId?: string;
  subscriptionId?: string;
  paymentId?: string;
  action?: string;
  actorType?: 'admin' | 'self' | 'system' | 'webhook';
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Audit log for billing state changes (D1k).
 *
 * `log(args)` is fire-and-forget safe — internal try/catch swallows
 * persist failures so a Mongo blip never breaks the user-facing
 * action. Failures are logged via Nest logger for ops alerting; we
 * accept temporary audit gaps over breaking the hot path.
 *
 * `query(args)` powers the admin investigation UI. Compound indexes
 * cover the common access patterns (targetUserId+date, subscriptionId
 * +date, paymentId+date, actorUserId+date, action+date).
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectModel(BillingAuditEvent.name)
    private readonly eventModel: Model<BillingAuditEvent>,
  ) {}

  async log(args: LogEventArgs): Promise<void> {
    try {
      await this.eventModel.create({
        action: args.action,
        actorType: args.actorType,
        actorUserId: this.toObjectId(args.actorUserId),
        targetUserId: this.toObjectId(args.targetUserId),
        subscriptionId: this.toObjectId(args.subscriptionId),
        paymentId: this.toObjectId(args.paymentId),
        refundRequestId: this.toObjectId(args.refundRequestId),
        planId: this.toObjectId(args.planId),
        couponId: this.toObjectId(args.couponId),
        metadata: args.metadata,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      });
    } catch (err) {
      this.logger.warn(
        `Audit log persist failed action=${args.action} err=${(err as Error).message}`,
      );
    }
  }

  async query(args: QueryEventsArgs) {
    const filter: any = {};
    if (args.actorUserId) filter.actorUserId = new Types.ObjectId(args.actorUserId);
    if (args.targetUserId) filter.targetUserId = new Types.ObjectId(args.targetUserId);
    if (args.subscriptionId) filter.subscriptionId = new Types.ObjectId(args.subscriptionId);
    if (args.paymentId) filter.paymentId = new Types.ObjectId(args.paymentId);
    if (args.action) filter.action = args.action;
    if (args.actorType) filter.actorType = args.actorType;
    if (args.dateFrom || args.dateTo) {
      filter.occurredAt = {};
      if (args.dateFrom) filter.occurredAt.$gte = args.dateFrom;
      if (args.dateTo) filter.occurredAt.$lte = args.dateTo;
    }

    const limit = Math.min(args.limit ?? 100, 500);
    const offset = args.offset ?? 0;
    const [items, total] = await Promise.all([
      this.eventModel.find(filter).sort({ occurredAt: -1 }).skip(offset).limit(limit).exec(),
      this.eventModel.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, offset };
  }

  private toObjectId(value: string | Types.ObjectId | undefined): Types.ObjectId | undefined {
    if (!value) return undefined;
    if (value instanceof Types.ObjectId) return value;
    try {
      return new Types.ObjectId(value);
    } catch {
      return undefined;
    }
  }
}
