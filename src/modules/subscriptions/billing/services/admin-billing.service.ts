import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../schemas/subscription.schema';
import { Plan } from '../../schemas/plan.schema';
import { User } from '../../../users/schemas/user.schema';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { SubscriptionsService } from '../../subscriptions.service';
import { PricingService } from './pricing.service';
import { RazorpayPlatformService } from './razorpay-platform.service';
import { InvoiceService } from './invoice.service';
import { AuditAction, AuditLogService } from './audit-log.service';

interface GrantArgs {
  adminUserId: string;
  userId: string;
  planId: string;
  billingCycle: 'monthly' | 'yearly';
  /** Custom duration overriding plan's monthly/yearly cadence (days). */
  durationDays?: number;
  reason: string;
  source?: 'admin' | 'paid_link' | 'manual_payment' | 'migrated';
}

interface ExtendArgs {
  adminUserId: string;
  subscriptionId: string;
  additionalDays: number;
  reason: string;
}

interface OverrideArgs {
  adminUserId: string;
  subscriptionId: string;
  /**
   * Sparse override of `appliedEntitlements`. Top-level keys overwrite
   * existing values. Nested arrays (e.g. moduleAccess) are REPLACED
   * wholesale — admin must supply the full updated array if changing
   * any entry. Audit snapshot retained on `entitlementsOverride`.
   */
  override: Record<string, unknown>;
  reason: string;
}

interface ManualPaymentArgs {
  adminUserId: string;
  userId: string;
  planId: string;
  billingCycle: 'monthly' | 'yearly';
  amountPaise: number;
  paymentMethod: 'cheque' | 'neft' | 'cash' | 'wire' | 'other';
  receiptNumber?: string;
  paymentDate?: Date;
  notes?: string;
}

interface PauseResumeArgs {
  adminUserId: string;
  subscriptionId: string;
  reason?: string;
  /** When pausing, optional resume-on date for time-bounded pauses. */
  resumeAt?: Date;
}

interface ForceCancelArgs {
  adminUserId: string;
  subscriptionId: string;
  reason: string;
  /** True = cancel immediately + revoke access. False = let period play out. */
  immediate?: boolean;
}

/**
 * Admin billing actions (D1i).
 *
 * Distinct from `RefundService` (D1h) and `AdminPaymentLinkService`
 * (D1i) which live in their own files. This service covers the
 * remaining admin actions:
 *   - grantSubscription: assign a plan to a user without payment
 *   - extendPeriod: add days to currentPeriodEnd
 *   - overrideEntitlements: sparse per-user feature override (the
 *     "give specific feature to specific user" path — bypasses plan
 *     limits without changing the plan)
 *   - recordManualPayment: record offline payment (cheque/NEFT/cash)
 *     and create the corresponding Subscription
 *   - pauseSubscription / resumeSubscription: admin-side, works for
 *     both mandate-bound and one-time subscriptions
 *   - forceCancel: cancel with admin override (vs user-initiated)
 *
 * Audit trail: every mutation writes `assignedBy`, `assignedAt`,
 * `assignmentNote` (or equivalent) onto the affected Subscription so
 * support can trace WHO did WHAT and WHY without a separate audit log.
 *
 * Mandate-bound subscriptions: pause/resume/cancel ALSO call the
 * Razorpay Subscriptions API so the mandate stops/starts at the
 * gateway. Local state then catches up via webhook (idempotent).
 */
@Injectable()
export class AdminBillingService {
  private readonly logger = new Logger(AdminBillingService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptionsService: SubscriptionsService,
    private readonly pricing: PricingService,
    private readonly razorpay: RazorpayPlatformService,
    private readonly audit: AuditLogService,
  ) {}

  // ── grant ───────────────────────────────────────────────────────────

  /**
   * Admin-grant a Subscription to a user without taking payment.
   * Optionally accepts a custom `durationDays` for non-standard
   * trial/comp grants. Supersedes any active subscription for the user
   * via the existing `subscribe()` helper, then patches `source` and
   * `assignedBy` for audit.
   */
  async grantSubscription(args: GrantArgs): Promise<Subscription> {
    const plan = await this.planModel.findById(args.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');

    // Reuse subscribe() to handle supersession + entitlements wiring.
    const subscription = await this.subscriptionsService.subscribe(
      args.userId,
      {
        planId: args.planId,
        billingCycle: args.billingCycle,
        activateImmediately: true,
      },
    );

    // Patch source + audit fields. If durationDays supplied, override
    // the period end the subscribe() helper computed.
    const update: any = {
      source: args.source ?? 'admin',
      assignedBy: new Types.ObjectId(args.adminUserId),
      assignedAt: new Date(),
      assignmentNote: args.reason,
    };
    if (args.durationDays && args.durationDays > 0) {
      const start = subscription.currentPeriodStart ?? new Date();
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + args.durationDays);
      update.currentPeriodEnd = end;
    }
    await this.subscriptionModel
      .updateOne({ _id: subscription._id }, { $set: update })
      .exec();

    this.logger.log(
      `Admin grant admin=${args.adminUserId} user=${args.userId} plan=${args.planId} sub=${subscription._id} reason="${args.reason}"`,
    );
    await this.audit.log({
      action: AuditAction.AdminGrant,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: args.userId,
      subscriptionId: String(subscription._id),
      planId: args.planId,
      metadata: {
        billingCycle: args.billingCycle,
        durationDays: args.durationDays,
        source: args.source ?? 'admin',
        reason: args.reason,
      },
    });
    return (await this.subscriptionModel
      .findById(subscription._id)
      .exec()) as Subscription;
  }

  // ── extend ──────────────────────────────────────────────────────────

  /**
   * Add `additionalDays` to a subscription's `currentPeriodEnd`.
   * Common use: service-outage compensation, goodwill credit, support
   * for partner deals. Refuses if subscription is not in an
   * extension-eligible state.
   */
  async extendPeriod(args: ExtendArgs): Promise<Subscription> {
    if (args.additionalDays <= 0) {
      throw new BadRequestException('additionalDays must be > 0');
    }
    const sub = await this.subscriptionModel
      .findById(args.subscriptionId)
      .exec();
    if (!sub) throw new NotFoundException('Subscription not found');
    if (
      !['active', 'trial', 'past_due', 'grace_period', 'paused'].includes(
        sub.status,
      )
    ) {
      throw new BadRequestException(
        `Cannot extend a subscription in status: ${sub.status}`,
      );
    }

    const baseEnd =
      sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()
        ? new Date(sub.currentPeriodEnd)
        : new Date();
    const newEnd = new Date(baseEnd);
    newEnd.setUTCDate(newEnd.getUTCDate() + args.additionalDays);

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        { _id: sub._id },
        {
          $set: {
            currentPeriodEnd: newEnd,
            assignedBy: new Types.ObjectId(args.adminUserId),
            assignedAt: new Date(),
            assignmentNote: `extend +${args.additionalDays}d: ${args.reason}`,
          },
        },
        { new: true },
      )
      .exec();
    this.logger.log(
      `Admin extend admin=${args.adminUserId} sub=${sub._id} +${args.additionalDays}d → ${newEnd.toISOString()}`,
    );
    await this.audit.log({
      action: AuditAction.AdminExtendPeriod,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: {
        additionalDays: args.additionalDays,
        before: { currentPeriodEnd: sub.currentPeriodEnd },
        after: { currentPeriodEnd: newEnd },
        reason: args.reason,
      },
    });
    return updated as Subscription;
  }

  // ── per-user feature override ───────────────────────────────────────

  /**
   * Sparsely override a subscription's `appliedEntitlements`. The
   * supplied object is shallow-merged onto the current entitlements
   * AND snapshotted onto `entitlementsOverride` for audit + future
   * reconciliation.
   *
   * Use cases:
   *   - "Give user X access to the GST module despite their plan not
   *     including it" — set `moduleAccess` array with the missing
   *     module + enabled:true.
   *   - "Bump user X's seat cap from 10 to 25 for this billing cycle"
   *     — set `maxTotalMembers: 25`.
   *   - "Remove a feature the user complained about by mistake" — set
   *     the relevant key back to false.
   *
   * NOTE: arrays (like `moduleAccess`) are REPLACED wholesale, not
   * merged — admin must supply the full updated list if changing any
   * entry. Reads-then-writes pattern; the controller surfaces a
   * `GET .../entitlements` first to populate the editor.
   */
  async overrideEntitlements(args: OverrideArgs): Promise<Subscription> {
    if (!args.override || Object.keys(args.override).length === 0) {
      throw new BadRequestException('override object must not be empty');
    }
    const sub = await this.subscriptionModel
      .findById(args.subscriptionId)
      .exec();
    if (!sub) throw new NotFoundException('Subscription not found');

    const merged = {
      ...(sub.appliedEntitlements as any),
      ...args.override,
    };
    const overrideSnapshot = {
      ...(sub.entitlementsOverride ?? {}),
      ...args.override,
    };

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        { _id: sub._id },
        {
          $set: {
            appliedEntitlements: merged,
            entitlementsOverride: overrideSnapshot,
            adminEntitlementOverride: true,
            assignedBy: new Types.ObjectId(args.adminUserId),
            assignedAt: new Date(),
            assignmentNote: `entitlement override: ${args.reason}`,
          },
        },
        { new: true },
      )
      .exec();
    this.logger.log(
      `Admin entitlement override admin=${args.adminUserId} sub=${sub._id} keys=${Object.keys(args.override).join(',')}`,
    );
    await this.audit.log({
      action: AuditAction.AdminEntitlementOverride,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: {
        overrideKeys: Object.keys(args.override),
        override: args.override,
        reason: args.reason,
      },
    });
    return updated as Subscription;
  }

  // ── manual payment ──────────────────────────────────────────────────

  /**
   * Record an offline payment (cheque / NEFT / cash / wire) and
   * create the corresponding Subscription. The SubscriptionPayment
   * row is stamped with `gateway='manual'` so it doesn't show up in
   * Razorpay reconciliations. Invoice generation auto-fires per D1f
   * once the row hits `captured`.
   */
  async recordManualPayment(args: ManualPaymentArgs): Promise<{
    payment: SubscriptionPayment;
    subscription: Subscription;
  }> {
    if (args.amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be > 0');
    }
    const plan = await this.planModel.findById(args.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');
    const user = await this.userModel
      .findById(args.userId)
      .select('name email mobile billingProfile')
      .exec();
    if (!user) throw new NotFoundException('User not found');

    // Reverse-quote from the supplied amount as the GST-inclusive total.
    const quote = this.pricing.computeQuote(plan, args.billingCycle, {
      finalTotalOverridePaise: args.amountPaise,
    });
    const billingSnapshot = InvoiceService.buildBillingSnapshot(user.toObject());
    const capturedAt = args.paymentDate ?? new Date();

    const payment = await this.paymentModel.create({
      userId: new Types.ObjectId(args.userId),
      planId: new Types.ObjectId(args.planId),
      billingCycle: args.billingCycle,
      paymentMode: 'one_time',
      status: 'captured',
      gateway: 'manual',
      planPricePaise: quote.basePricePaise,
      discountPaise: quote.discountPaise,
      gstPaise: quote.gstPaise,
      totalPaise: quote.totalPaise,
      gstRatePercent: quote.gstRatePercent,
      manualReceiptNumber: args.receiptNumber,
      manualPaymentMethod: args.paymentMethod,
      manualPaymentDate: capturedAt,
      manualNotes: args.notes,
      manualRecordedBy: new Types.ObjectId(args.adminUserId),
      capturedAt,
      billingSnapshot,
    });

    // Create the Subscription via subscribe() helper so supersession
    // and addons-handling fire correctly.
    const subscription = await this.subscriptionsService.subscribe(
      args.userId,
      {
        planId: args.planId,
        billingCycle: args.billingCycle,
        activateImmediately: true,
      },
    );
    await this.subscriptionModel
      .updateOne(
        { _id: subscription._id },
        {
          $set: {
            source: 'manual_payment',
            assignedBy: new Types.ObjectId(args.adminUserId),
            assignedAt: new Date(),
            assignmentNote: `manual ${args.paymentMethod}${args.receiptNumber ? ' #' + args.receiptNumber : ''}`,
          },
        },
      )
      .exec();
    payment.subscriptionId = subscription._id as Types.ObjectId;
    await payment.save();

    this.logger.log(
      `Admin manual payment admin=${args.adminUserId} user=${args.userId} method=${args.paymentMethod} amount=${args.amountPaise} payment=${payment._id} sub=${subscription._id}`,
    );
    await this.audit.log({
      action: AuditAction.AdminManualPayment,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: args.userId,
      subscriptionId: String(subscription._id),
      paymentId: String(payment._id),
      planId: args.planId,
      metadata: {
        amountPaise: args.amountPaise,
        paymentMethod: args.paymentMethod,
        receiptNumber: args.receiptNumber,
        billingCycle: args.billingCycle,
      },
    });
    return { payment, subscription };
  }

  // ── pause / resume / force-cancel ───────────────────────────────────

  /**
   * Pause a subscription. If mandate-bound, also call Razorpay's
   * subscription.pause to stop the recurring debit. Local state
   * mirrors via webhook, but we set it optimistically here so admin
   * UI shows the change immediately.
   */
  async pauseSubscription(args: PauseResumeArgs): Promise<Subscription> {
    const sub = await this.subscriptionModel
      .findById(args.subscriptionId)
      .exec();
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.status === 'paused') {
      throw new ConflictException('Subscription is already paused');
    }
    if (
      !['active', 'trial', 'past_due', 'grace_period'].includes(sub.status)
    ) {
      throw new BadRequestException(
        `Cannot pause a subscription in status: ${sub.status}`,
      );
    }

    // Razorpay-side pause for mandate-bound subs.
    if (sub.razorpaySubscriptionId) {
      await this.razorpay.pauseSubscription(sub.razorpaySubscriptionId);
    }

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        { _id: sub._id },
        {
          $set: {
            status: 'paused',
            isPaused: true,
            pausedAt: new Date(),
            pauseReason: args.reason ?? 'admin_pause',
            ...(args.resumeAt ? { resumeAt: args.resumeAt } : {}),
            assignedBy: new Types.ObjectId(args.adminUserId),
            assignedAt: new Date(),
            assignmentNote: `admin pause: ${args.reason ?? 'no reason'}`,
          },
        },
        { new: true },
      )
      .exec();
    this.logger.log(
      `Admin pause admin=${args.adminUserId} sub=${sub._id} reason="${args.reason}"`,
    );
    await this.audit.log({
      action: AuditAction.AdminPause,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: { reason: args.reason, resumeAt: args.resumeAt },
    });
    return updated as Subscription;
  }

  async resumeSubscription(args: PauseResumeArgs): Promise<Subscription> {
    const sub = await this.subscriptionModel
      .findById(args.subscriptionId)
      .exec();
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.status !== 'paused') {
      throw new BadRequestException(
        `Cannot resume a subscription in status: ${sub.status}`,
      );
    }

    if (sub.razorpaySubscriptionId) {
      await this.razorpay.resumeSubscription(sub.razorpaySubscriptionId);
    }

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        { _id: sub._id },
        {
          $set: {
            status: 'active',
            isPaused: false,
            assignedBy: new Types.ObjectId(args.adminUserId),
            assignedAt: new Date(),
            assignmentNote: `admin resume: ${args.reason ?? 'no reason'}`,
          },
          $unset: { pausedAt: '', pauseReason: '', resumeAt: '' },
        },
        { new: true },
      )
      .exec();
    this.logger.log(
      `Admin resume admin=${args.adminUserId} sub=${sub._id}`,
    );
    await this.audit.log({
      action: AuditAction.AdminResume,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: { reason: args.reason },
    });
    return updated as Subscription;
  }

  /**
   * Force-cancel a subscription with admin override. `immediate=true`
   * revokes access NOW (status='cancelled', currentPeriodEnd set to
   * now). `immediate=false` preserves access until current period
   * ends (status='cancelled', cancelledAt now, period unchanged).
   *
   * For mandate-bound subs, the corresponding Razorpay subscription
   * is also cancelled (cancel-at-cycle-end matches `!immediate`).
   */
  async forceCancel(args: ForceCancelArgs): Promise<Subscription> {
    const sub = await this.subscriptionModel
      .findById(args.subscriptionId)
      .exec();
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.status === 'cancelled' || sub.status === 'expired') {
      throw new ConflictException(
        `Subscription is already ${sub.status}`,
      );
    }

    if (sub.razorpaySubscriptionId) {
      await this.razorpay.cancelSubscription(
        sub.razorpaySubscriptionId,
        !args.immediate,
      );
    }

    const update: any = {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancellationReason: `admin_force_cancel: ${args.reason}`,
      assignedBy: new Types.ObjectId(args.adminUserId),
      assignedAt: new Date(),
      assignmentNote: `force cancel ${args.immediate ? 'immediate' : 'at-cycle-end'}: ${args.reason}`,
    };
    if (args.immediate) {
      update.currentPeriodEnd = new Date();
    }

    const updated = await this.subscriptionModel
      .findOneAndUpdate({ _id: sub._id }, { $set: update }, { new: true })
      .exec();
    this.logger.log(
      `Admin force-cancel admin=${args.adminUserId} sub=${sub._id} immediate=${!!args.immediate}`,
    );
    await this.audit.log({
      action: AuditAction.AdminForceCancel,
      actorType: 'admin',
      actorUserId: args.adminUserId,
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: {
        immediate: !!args.immediate,
        reason: args.reason,
        before: { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd },
      },
    });
    return updated as Subscription;
  }

  // ── read helpers (admin) ────────────────────────────────────────────

  async fetchSubscription(subscriptionId: string): Promise<Subscription> {
    const sub = await this.subscriptionModel
      .findById(subscriptionId)
      .populate<{ planId: Plan }>('planId')
      .exec();
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  async listUserSubscriptions(userId: string): Promise<Subscription[]> {
    return this.subscriptionModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .populate<{ planId: Plan }>('planId')
      .exec();
  }
}
