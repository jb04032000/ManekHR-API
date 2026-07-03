import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Plan, PlanEntitlements } from '../../schemas/plan.schema';
import { Subscription } from '../../schemas/subscription.schema';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { User } from '../../../users/schemas/user.schema';
import { AddOnsService } from '../../../add-ons/add-ons.service';
import { BillingCycle, PlanChangeQuote } from '../billing.types';
import { ProrationService } from './proration.service';
import { CouponService } from './coupon.service';
import { PricingService } from './pricing.service';
import { RazorpayPlatformService } from './razorpay-platform.service';
import { BillingPolicyService } from './billing-policy.service';
import { InvoiceService } from './invoice.service';
import { AuditAction, AuditLogService } from './audit-log.service';
import {
  ExecutePlanChangeDto,
  PreviewPlanChangeDto,
  ConfirmPlanChangeDto,
} from '../dto/plan-change.dto';

/** Result of `executePlanChange` — discriminated on `mode`. */
type ExecutePlanChangeResult =
  | {
      mode: 'payment';
      orderId: string;
      razorpayKeyId: string;
      amountPaise: number;
      currency: 'INR';
      subscriptionPaymentId: string;
      quote: PlanChangeQuote;
    }
  | {
      mode: 'applied';
      subscription: Subscription;
      quote: PlanChangeQuote;
    }
  | {
      mode: 'scheduled';
      scheduledSubscriptionId: string;
      effectiveDate: string;
    };

interface ConfirmPlanChangeResult {
  subscriptionId: string;
  paymentId: string;
  appliedAt: Date;
}

/**
 * Customer-facing change-plan engine (Task 4 — upgrade / downgrade with
 * proration). Sits on top of `ProrationService` (the pure money-math
 * engine, Task 3) and orchestrates the writes a real plan change needs.
 *
 * Three entry points:
 *   - `previewPlanChange`  — read-only; returns a `PlanChangeQuote`.
 *   - `executePlanChange`  — recomputes the quote server-side and either
 *       (a) raises a Razorpay order for an upgrade with a net charge,
 *       (b) applies a free / lateral upgrade in place, or
 *       (c) schedules a deferred downgrade.
 *   - `confirmPlanChange`  — verifies the signed Razorpay payload for an
 *       upgrade order and applies the plan change.
 *
 * Money model: all integer paise, sourced from the `PlanChangeQuote`.
 *
 * Upgrade-apply semantics: an upgrade is applied IN PLACE on the existing
 * active subscription — same `_id`, same identity. This differs from
 * `SubscriptionsService.subscribe()`, which supersedes the old row and
 * creates a new one. The in-place model keeps `previousSubscriptionId`
 * chains, add-on links, and Razorpay handles stable across the change.
 *
 * Entitlements: the upgrade swaps `purchasedEntitlements` to the target
 * plan's entitlements, then re-derives `appliedEntitlements`. The
 * pre-paid `communications` credit balances (SMS / WhatsApp) are imperative
 * state — they MUST survive the swap; both the explicit carry-over below
 * and `AddOnsService.recalculateAppliedEntitlements` preserve them.
 */
@Injectable()
export class PlanChangeService {
  private readonly logger = new Logger(PlanChangeService.name);

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly proration: ProrationService,
    private readonly coupons: CouponService,
    private readonly pricing: PricingService,
    private readonly razorpay: RazorpayPlatformService,
    private readonly billingPolicy: BillingPolicyService,
    private readonly invoices: InvoiceService,
    private readonly audit: AuditLogService,
    @Inject(forwardRef(() => AddOnsService))
    private readonly addOnsService: AddOnsService,
  ) {}

  // ── preview ─────────────────────────────────────────────────────────

  /**
   * Read-only proration preview. Loads the customer's current
   * active/trial subscription + the target plan, resolves any coupon,
   * and returns the `PlanChangeQuote`. Performs NO writes.
   */
  async previewPlanChange(userId: string, dto: PreviewPlanChangeDto): Promise<PlanChangeQuote> {
    const { subscription, currentPlan } = await this.loadCurrentSubscription(userId);
    const targetPlan = await this.loadTargetPlan(dto.targetPlanId, userId);

    const targetDiscountOnBasePaise = await this.resolveTargetDiscount({
      userId,
      targetPlan,
      billingCycle: dto.billingCycle,
      couponCodes: dto.couponCodes,
    });

    return this.proration.computePlanChangeQuote({
      subscription,
      currentPlan,
      targetPlan,
      targetBillingCycle: dto.billingCycle,
      targetDiscountOnBasePaise,
      appliedCouponCode: this.firstCouponCode(dto.couponCodes),
    });
  }

  // ── execute ─────────────────────────────────────────────────────────

  /**
   * Recompute the quote server-side and act on it. Never trusts a
   * client-supplied quote — the proration is re-derived here from the
   * live subscription + plan + policy.
   */
  async executePlanChange(
    userId: string,
    dto: ExecutePlanChangeDto,
  ): Promise<ExecutePlanChangeResult> {
    const { subscription, currentPlan } = await this.loadCurrentSubscription(userId);
    const targetPlan = await this.loadTargetPlan(dto.targetPlanId, userId);

    const targetDiscountOnBasePaise = await this.resolveTargetDiscount({
      userId,
      targetPlan,
      billingCycle: dto.billingCycle,
      couponCodes: dto.couponCodes,
    });

    const quote = await this.proration.computePlanChangeQuote({
      subscription,
      currentPlan,
      targetPlan,
      targetBillingCycle: dto.billingCycle,
      targetDiscountOnBasePaise,
      appliedCouponCode: this.firstCouponCode(dto.couponCodes),
    });

    const policy = await this.billingPolicy.getPolicy();

    // ── downgrade ────────────────────────────────────────────────────
    if (quote.direction === 'downgrade') {
      if (policy.proration.allowDowngrade === false) {
        throw new BadRequestException(
          'Plan downgrades are not available. Contact support if you need to switch to a lower plan.',
        );
      }
      return this.scheduleDowngrade({
        userId,
        subscription,
        targetPlan,
        targetBillingCycle: dto.billingCycle,
        quote,
      });
    }

    // ── upgrade / lateral with a net charge → Razorpay order ─────────
    if (quote.netPayablePaise > 0) {
      return this.raiseUpgradeOrder({
        userId,
        subscription,
        targetPlan,
        targetBillingCycle: dto.billingCycle,
        quote,
      });
    }

    // ── upgrade / lateral fully covered by credit → apply in place ───
    const updated = await this.applyUpgrade(subscription, targetPlan, quote);
    await this.audit.log({
      action: AuditAction.SelfPlanChangeApplied,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(subscription._id),
      planId: String(targetPlan._id),
      metadata: {
        direction: quote.direction,
        netPayablePaise: 0,
        mode: 'credit_covered',
      },
    });
    return { mode: 'applied', subscription: updated, quote };
  }

  // ── confirm ─────────────────────────────────────────────────────────

  /**
   * Confirm an upgrade proration charge. Verifies ownership + the
   * Razorpay signature, transitions the payment row to `captured`
   * race-safely, then applies the plan change. Idempotent — a repeat
   * confirm on an already-captured payment returns the cached result.
   */
  async confirmPlanChange(
    userId: string,
    dto: ConfirmPlanChangeDto,
  ): Promise<ConfirmPlanChangeResult> {
    const payment = await this.paymentModel.findById(dto.subscriptionPaymentId).exec();
    if (!payment) {
      throw new NotFoundException('Plan-change payment record not found');
    }
    if (String(payment.userId) !== userId) {
      throw new ForbiddenException('Payment record does not belong to user');
    }
    if (payment.context !== 'plan_change') {
      throw new BadRequestException('Payment record is not a plan-change payment');
    }
    if (payment.gatewayOrderId !== dto.razorpayOrderId) {
      throw new BadRequestException('Razorpay order id mismatch');
    }

    // Idempotent path — already captured + applied.
    if (payment.status === 'captured' && payment.subscriptionId) {
      return this.toConfirmResult(payment);
    }
    if (payment.status !== 'created') {
      throw new BadRequestException(`Payment is in non-confirmable state: ${payment.status}`);
    }

    const verified = this.razorpay.verifyCheckoutSignature({
      orderId: dto.razorpayOrderId,
      paymentId: dto.razorpayPaymentId,
      signature: dto.razorpaySignature,
    });
    if (!verified) {
      throw new BadRequestException('Razorpay signature verification failed');
    }

    // Atomic created → captured transition. If another request beat us,
    // re-read and return idempotently.
    const now = new Date();
    const captured = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id, status: 'created' },
        {
          $set: {
            status: 'captured',
            gatewayPaymentId: dto.razorpayPaymentId,
            capturedAt: now,
            attemptNumber: 1,
          },
        },
        { new: true },
      )
      .exec();

    if (!captured) {
      const reread = await this.paymentModel.findById(payment._id).exec();
      if (reread && reread.status === 'captured' && reread.subscriptionId) {
        return this.toConfirmResult(reread);
      }
      throw new BadRequestException('Payment is not in a confirmable state');
    }

    return this.applyCapturedPaymentInternal(captured, userId);
  }

  /**
   * Apply an already-captured plan-change payment. Public so the Razorpay
   * webhook (the abandoned-tab case where the customer paid but never hit
   * `/change-plan/confirm`) can drive the same apply path. `confirmPlanChange`
   * and this method share `applyCapturedPaymentInternal`.
   *
   * Exactly-once: this method and a concurrent `confirmPlanChange` can both
   * be in flight for the same payment. The guarantee is enforced inside
   * `applyCapturedPaymentInternal` by an atomic claim on linking
   * `payment.subscriptionId` — only the racer that wins the link runs the
   * in-place upgrade (and its single Razorpay `updateSubscriptionPlan` call
   * + audit row); a loser re-reads and returns the existing result. The
   * `subscriptionId`-set fast-path below is a cheap short-circuit for an
   * already-applied payment (e.g. a replayed webhook); it is NOT the
   * exactly-once gate — the atomic claim is.
   */
  async applyCapturedPlanChangePayment(
    subscriptionPaymentId: string,
  ): Promise<ConfirmPlanChangeResult> {
    const payment = await this.paymentModel.findById(subscriptionPaymentId).exec();
    if (!payment) {
      throw new NotFoundException('Plan-change payment record not found');
    }
    if (payment.context !== 'plan_change') {
      throw new BadRequestException('Payment record is not a plan-change payment');
    }
    if (payment.status !== 'captured') {
      throw new BadRequestException(`Payment is not captured (status=${payment.status})`);
    }
    // Fast-path — already linked to a subscription, nothing to do. The
    // atomic claim in `applyCapturedPaymentInternal` is the authoritative
    // guard; this just avoids a redundant plan + subscription read.
    if (payment.subscriptionId) {
      return this.toConfirmResult(payment);
    }
    return this.applyCapturedPaymentInternal(payment, String(payment.userId));
  }

  // ── shared confirm-side apply ───────────────────────────────────────

  /**
   * Given a captured plan-change `SubscriptionPayment`, apply the upgrade
   * to the customer's active subscription, fire the GST invoice, and
   * audit. The single apply path shared by `confirmPlanChange` and
   * `applyCapturedPlanChangePayment`.
   *
   * Exactly-once apply: the in-place upgrade is applied on the customer's
   * existing active subscription, so the target subscription `_id` is known
   * BEFORE `applyUpgrade` runs. We exploit that to make the
   * `payment.subscriptionId` link a one-way claim marker: an atomic
   * `findOneAndUpdate({ _id, status:'captured', subscriptionId:{$exists:false} },
   * { $set:{ subscriptionId } })` lets exactly one racer win. Only the winner
   * runs `applyUpgrade` (and thus the single Razorpay `updateSubscriptionPlan`
   * call) + invoice + audit; a loser re-reads and returns the existing
   * result idempotently. The link is claimed BEFORE `applyUpgrade` precisely
   * so a redundant Razorpay call / duplicate audit row cannot happen.
   *
   * The `created → captured` atomic transition in `confirmPlanChange` /
   * the webhook is an earlier gate on the SAME contention — but a webhook
   * may legitimately deliver `payment.captured` for a row a prior `/confirm`
   * already captured-but-not-yet-linked, so the link claim here is the
   * backstop that holds regardless of capture/confirm ordering.
   */
  private async applyCapturedPaymentInternal(
    captured: SubscriptionPayment,
    userId: string,
  ): Promise<ConfirmPlanChangeResult> {
    const targetPlan = await this.planModel.findById(captured.planId).exec();
    if (!targetPlan) {
      throw new NotFoundException('Target plan not found for plan change');
    }

    const { subscription, currentPlan } = await this.loadCurrentSubscription(userId);

    // ── atomic exactly-once claim ──────────────────────────────────────
    // The upgrade is applied IN PLACE — `applyUpgrade` mutates this same
    // `subscription` row and never creates a new one — so its `_id` is the
    // subscription this payment pays for. Atomically link it, gated on the
    // link being unset, so only one racer (this method vs a concurrent
    // `confirmPlanChange`, or two webhook deliveries) proceeds to apply.
    const subscriptionId = subscription._id;
    const claimed = await this.paymentModel
      .findOneAndUpdate(
        {
          _id: captured._id,
          context: 'plan_change',
          status: 'captured',
          subscriptionId: { $exists: false },
        },
        { $set: { subscriptionId } },
        { new: true },
      )
      .exec();

    if (!claimed) {
      // Lost the claim — another racer already linked (and is applying /
      // has applied) the upgrade. Re-read and return its result.
      const reread = await this.paymentModel.findById(captured._id).exec();
      if (reread && reread.subscriptionId) {
        return this.toConfirmResult(reread);
      }
      // Defensive: claim failed but no link present — surface rather than
      // silently double-apply.
      throw new BadRequestException('Plan-change payment could not be claimed for apply');
    }

    // Recompute the quote at apply time so `applyUpgrade` knows whether
    // the change is same-cycle (keep the period) or cross-cycle (reset).
    const quote = await this.proration.computePlanChangeQuote({
      subscription,
      currentPlan,
      targetPlan,
      targetBillingCycle: claimed.billingCycle as BillingCycle,
    });

    let updated: Subscription;
    try {
      updated = await this.applyUpgrade(subscription, targetPlan, quote);
    } catch (err) {
      // Hard failure AFTER we won the claim (e.g. the subscription vanished
      // between load and apply). Release the link so a webhook retry can
      // re-claim and re-attempt — otherwise the payment is permanently
      // "claimed" but never upgraded.
      await this.paymentModel
        .updateOne({ _id: claimed._id, subscriptionId }, { $unset: { subscriptionId: '' } })
        .exec();
      this.logger.error(
        `Plan-change apply failed after claim payment=${String(claimed._id)}: ${(err as Error).message}`,
      );
      throw err;
    }

    // GST invoice — fire-and-forget, mirroring checkout's confirmPayment.
    // The download endpoint is the recovery path if this hiccups.
    this.invoices
      .generate(String(claimed._id))
      .catch((err) =>
        this.logger.warn(
          `Plan-change invoice generation failed payment=${String(claimed._id)} err=${(err as Error).message}`,
        ),
      );

    await this.audit.log({
      action: AuditAction.SelfPlanChangeApplied,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(updated._id),
      paymentId: String(claimed._id),
      planId: String(targetPlan._id),
      metadata: {
        direction: quote.direction,
        totalPaise: claimed.totalPaise,
        mode: 'paid',
      },
    });

    this.logger.log(
      `Plan change confirmed user=${userId} payment=${String(claimed._id)} sub=${String(updated._id)}`,
    );

    return {
      subscriptionId: String(updated._id),
      paymentId: String(claimed._id),
      appliedAt: claimed.capturedAt ?? new Date(),
    };
  }

  // ── upgrade order (Razorpay) ────────────────────────────────────────

  /**
   * Raise a Razorpay order for an upgrade that carries a net charge.
   * Persists a `context='plan_change'` `SubscriptionPayment` in `created`
   * state with the money fields from the quote, then creates the order.
   */
  private async raiseUpgradeOrder(args: {
    userId: string;
    subscription: Subscription;
    targetPlan: Plan;
    targetBillingCycle: BillingCycle;
    quote: PlanChangeQuote;
  }): Promise<ExecutePlanChangeResult> {
    const { userId, subscription, targetPlan, targetBillingCycle, quote } = args;

    const order = await this.razorpay.createOrder({
      amountPaise: quote.netPayablePaise,
      receipt: this.buildReceipt(userId),
      notes: {
        userId,
        planId: String(targetPlan._id),
        billingCycle: targetBillingCycle,
        context: 'plan_change',
        direction: quote.direction,
        fromPlanId: quote.currentPlanId,
      },
    });

    // Billing-profile snapshot — same source fields as checkout so the
    // invoice generator stays reproducible without re-reading User.
    const userForSnapshot = await this.userModel
      .findById(userId)
      .select('name email mobile billingProfile')
      .exec();
    const billingSnapshot = userForSnapshot
      ? InvoiceService.buildBillingSnapshot(userForSnapshot.toObject())
      : undefined;

    const payment = await this.paymentModel.create({
      userId: new Types.ObjectId(userId),
      subscriptionId: subscription._id,
      planId: targetPlan._id,
      billingCycle: targetBillingCycle,
      paymentMode: 'one_time',
      context: 'plan_change',
      status: 'created',
      gateway: 'razorpay',
      gatewayOrderId: order.id,
      // Money snapshot from the proration quote. `planPricePaise` carries
      // the taxable target charge (pre-GST, pre-credit); `discountPaise`
      // carries the unused-time credit applied; `gstPaise` is the GST on
      // the net; `totalPaise` is what the customer actually pays now.
      planPricePaise: quote.targetChargePaise,
      discountPaise: quote.unusedCreditPaise,
      gstPaise: quote.gstPaise,
      totalPaise: quote.netPayablePaise,
      gstRatePercent: quote.gstRatePercent,
      ...(billingSnapshot ? { billingSnapshot } : {}),
      ...(quote.appliedCouponCode ? { appliedCouponCode: quote.appliedCouponCode } : {}),
    });

    await this.audit.log({
      action: AuditAction.SelfPlanChangeInitiated,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(subscription._id),
      paymentId: String(payment._id),
      planId: String(targetPlan._id),
      metadata: {
        gatewayOrderId: order.id,
        direction: quote.direction,
        billingCycle: targetBillingCycle,
        netPayablePaise: quote.netPayablePaise,
      },
    });

    this.logger.log(
      `Plan-change order created user=${userId} plan=${String(targetPlan._id)} cycle=${targetBillingCycle} order=${order.id} payment=${String(payment._id)}`,
    );

    return {
      mode: 'payment',
      orderId: order.id,
      razorpayKeyId: this.razorpay.getKeyId(),
      amountPaise: quote.netPayablePaise,
      currency: 'INR',
      subscriptionPaymentId: String(payment._id),
      quote,
    };
  }

  // ── downgrade (scheduled) ───────────────────────────────────────────

  /**
   * Create a `status='scheduled'` subscription row for a deferred
   * downgrade. The change takes effect at the current period end; the
   * existing `processScheduledSubscriptions` cron promotes it.
   */
  private async scheduleDowngrade(args: {
    userId: string;
    subscription: Subscription;
    targetPlan: Plan;
    targetBillingCycle: BillingCycle;
    quote: PlanChangeQuote;
  }): Promise<ExecutePlanChangeResult> {
    const { userId, subscription, targetPlan, targetBillingCycle, quote } = args;

    // One scheduled row per user — pre-check for a friendly error; the
    // partial-unique index on (userId, status='scheduled') is the backstop.
    const existingScheduled = await this.subscriptionModel
      .findOne({ userId: new Types.ObjectId(userId), status: 'scheduled' })
      .exec();
    if (existingScheduled) {
      throw new BadRequestException(
        'A scheduled plan change already exists. Cancel it before scheduling another.',
      );
    }

    // The scheduled row starts when the current period ends.
    const periodStart = subscription.currentPeriodEnd ?? new Date();
    const periodEnd = this.addCycle(periodStart, targetBillingCycle);

    // Target-plan entitlements, deep-cloned so a later edit to the plan
    // doc never mutates this snapshot. Carry over the imperative
    // `communications` credit balances from the live subscription.
    const entitlements = this.cloneEntitlementsPreservingComms(
      targetPlan.entitlements,
      subscription.appliedEntitlements,
    );

    const scheduled = await this.subscriptionModel.create({
      userId: new Types.ObjectId(userId),
      planId: targetPlan._id,
      status: 'scheduled',
      billingCycle: targetBillingCycle,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      purchasedEntitlements: entitlements,
      appliedEntitlements: entitlements,
      previousSubscriptionId: subscription._id,
      source: 'self',
      ...(subscription.workspaceId ? { workspaceId: subscription.workspaceId } : {}),
    });

    // If the current subscription is mandate-bound, schedule the Razorpay
    // plan change for cycle end too — so auto-debit charges the new plan
    // from the next renewal. Skip (and warn) when the target plan has no
    // Razorpay plan mirror yet: the mirror is lazily created on next
    // mandate use, and a missing mirror must NOT block the downgrade.
    if (subscription.razorpaySubscriptionId) {
      const razorpayPlanId = this.razorpayPlanIdFor(targetPlan, targetBillingCycle);
      if (razorpayPlanId) {
        try {
          await this.razorpay.updateSubscriptionPlan({
            subscriptionId: subscription.razorpaySubscriptionId,
            newPlanId: razorpayPlanId,
            scheduleChangeAt: 'cycle_end',
          });
        } catch (err) {
          // The local scheduled row is already persisted — never fail
          // the customer-facing downgrade on a Razorpay hiccup. Ops can
          // reconcile via the mandate-admin tooling.
          this.logger.warn(
            `Razorpay updateSubscriptionPlan failed for downgrade sub=${String(subscription._id)} err=${(err as Error).message}`,
          );
        }
      } else {
        this.logger.warn(
          `Downgrade scheduled without Razorpay plan change — target plan ${String(targetPlan._id)} has no razorpayPlanId for ${targetBillingCycle}; mirror will be created lazily on next mandate use`,
        );
      }
    }

    await this.audit.log({
      action: AuditAction.SelfPlanChangeScheduled,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(scheduled._id),
      planId: String(targetPlan._id),
      metadata: {
        direction: quote.direction,
        billingCycle: targetBillingCycle,
        effectiveDate: quote.effectiveDate,
        fromSubscriptionId: String(subscription._id),
      },
    });

    this.logger.log(
      `Plan-change downgrade scheduled user=${userId} plan=${String(targetPlan._id)} scheduledSub=${String(scheduled._id)} effective=${quote.effectiveDate}`,
    );

    return {
      mode: 'scheduled',
      scheduledSubscriptionId: String(scheduled._id),
      effectiveDate: quote.effectiveDate,
    };
  }

  // ── in-place upgrade apply ──────────────────────────────────────────

  /**
   * Apply an upgrade IN PLACE on the existing active subscription. The
   * subscription keeps its `_id` / identity — no supersede, no new row.
   *
   *   - `planId` → the target plan.
   *   - `purchasedEntitlements` / `appliedEntitlements` → the target
   *     plan's entitlements (deep clone), with the `communications`
   *     credit balances carried over from the current subscription.
   *   - Same-cycle upgrade: period + cycle untouched.
   *   - Cross-cycle upgrade: cycle switches, period resets to
   *     [now, quote.renewalDate].
   *
   * After persisting, `AddOnsService.recalculateAppliedEntitlements`
   * re-layers any active add-on deltas on top (it also re-preserves the
   * `communications` balances). The explicit carry-over below stands
   * even when that recompute is skipped (admin entitlement override).
   *
   * Returns the updated subscription document.
   */
  private async applyUpgrade(
    currentSubscription: Subscription,
    targetPlan: Plan,
    quote: PlanChangeQuote,
  ): Promise<Subscription> {
    // Re-load a hydrated document to mutate — the caller may have handed
    // us a populated copy whose `planId` is a Plan, not an ObjectId.
    const sub = await this.subscriptionModel.findById(currentSubscription._id).exec();
    if (!sub) {
      throw new NotFoundException('Subscription no longer exists');
    }

    const entitlements = this.cloneEntitlementsPreservingComms(
      targetPlan.entitlements,
      sub.appliedEntitlements,
    );

    sub.planId = targetPlan._id;
    sub.purchasedEntitlements = entitlements;
    sub.appliedEntitlements = entitlements;

    const sameCycle = quote.currentBillingCycle === quote.targetBillingCycle;
    if (!sameCycle) {
      // Cross-cycle (monthly↔yearly) — the customer bought a fresh
      // target cycle; reset the billing window.
      sub.billingCycle = quote.targetBillingCycle;
      sub.currentPeriodStart = new Date();
      sub.currentPeriodEnd = new Date(quote.renewalDate);
    }
    // Same-cycle: keep billingCycle + currentPeriodStart/End untouched.

    await sub.save();

    // If mandate-bound, schedule the Razorpay plan change for cycle end
    // so auto-debit picks up the new plan from the next renewal. Skip +
    // warn when the target has no Razorpay plan mirror yet (created
    // lazily on next mandate use — must not block the upgrade).
    if (sub.razorpaySubscriptionId) {
      const razorpayPlanId = this.razorpayPlanIdFor(targetPlan, sub.billingCycle as BillingCycle);
      if (razorpayPlanId) {
        try {
          await this.razorpay.updateSubscriptionPlan({
            subscriptionId: sub.razorpaySubscriptionId,
            newPlanId: razorpayPlanId,
            scheduleChangeAt: 'cycle_end',
          });
        } catch (err) {
          this.logger.warn(
            `Razorpay updateSubscriptionPlan failed for upgrade sub=${String(sub._id)} err=${(err as Error).message}`,
          );
        }
      } else {
        this.logger.warn(
          `Upgrade applied without Razorpay plan change — target plan ${String(targetPlan._id)} has no razorpayPlanId for ${sub.billingCycle}; mirror will be created lazily on next mandate use`,
        );
      }
    }

    // Re-derive appliedEntitlements with any active add-on deltas layered
    // on top of the new plan base. This mirrors what
    // `SubscriptionsService.subscribe()` does for a plan change (it calls
    // `addOnsService.handleSubscriptionChange`, which ends in the same
    // recompute). `recalculateAppliedEntitlements` also re-preserves the
    // `communications` balances. It is a no-op when an admin entitlement
    // override is set — in which case our explicit set above is the
    // authoritative state. Add-on rows stay linked to this subscription's
    // `_id` (identity is unchanged), so they are still picked up.
    try {
      await this.addOnsService.recalculateAppliedEntitlements(String(sub.userId));
    } catch (err) {
      // Entitlements are already correct from the explicit set above;
      // an add-on recompute hiccup must not fail the user-facing apply.
      this.logger.warn(
        `Add-on entitlement recompute failed after plan-change apply sub=${String(sub._id)} err=${(err as Error).message}`,
      );
    }

    // Return the freshest copy (recalculate may have re-written
    // appliedEntitlements with add-on deltas).
    const refreshed = await this.subscriptionModel.findById(sub._id).exec();
    return refreshed ?? sub;
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * Load the customer's current active / trial subscription + its plan.
   * Throws `BadRequestException` when there is nothing to change.
   */
  private async loadCurrentSubscription(
    userId: string,
  ): Promise<{ subscription: Subscription; currentPlan: Plan }> {
    const now = new Date();
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
        currentPeriodEnd: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .populate<{ planId: Plan }>('planId')
      .exec();

    if (!subscription) {
      throw new BadRequestException('No active subscription to change');
    }

    const currentPlan = subscription.planId;
    if (!currentPlan || !(currentPlan as any)._id) {
      // Plan reference dangling — cannot price a change against it.
      throw new BadRequestException('Current plan could not be resolved for this subscription');
    }

    return { subscription, currentPlan };
  }

  /**
   * Load + validate the target plan. Rejects an inactive plan and a
   * custom plan the user is not entitled to (mirroring how
   * `SubscriptionCheckoutService.assertPlanEligibleForUser` gates a
   * direct checkout).
   */
  private async loadTargetPlan(targetPlanId: string, userId: string): Promise<Plan> {
    const plan = await this.planModel.findById(targetPlanId).exec();
    if (!plan) throw new NotFoundException('Target plan not found');
    if (!plan.isActive) {
      throw new BadRequestException('Target plan is not active');
    }

    if (plan.isCustom) {
      const userObjectId = new Types.ObjectId(userId);
      const assignedToUser =
        plan.assignedUserId && plan.assignedUserId.toString() === userObjectId.toString();

      let assignedViaWorkspace = false;
      if (!assignedToUser && plan.assignedWorkspaceId) {
        const memberRow = await this.subscriptionModel.db.collection('workspacemembers').findOne({
          workspaceId: plan.assignedWorkspaceId,
          userId: userObjectId,
          status: 'active',
          role: { $in: ['owner', 'admin'] },
        });
        assignedViaWorkspace = !!memberRow;
      }

      if (!assignedToUser && !assignedViaWorkspace) {
        throw new ForbiddenException('This custom plan is not available for your account');
      }
    }

    return plan;
  }

  /**
   * Resolve customer-supplied coupon codes to a `discountOnBasePaise`
   * for the target plan + cycle. Only the discount-on-base effect is
   * honoured for a plan change; a `fixed_price` coupon's final-total
   * override is converted into an equivalent base discount
   * (`basePrice - finalTotalOverride`, clamped >= 0). Returns `undefined`
   * when no codes were supplied.
   */
  private async resolveTargetDiscount(args: {
    userId: string;
    targetPlan: Plan;
    billingCycle: BillingCycle;
    couponCodes?: string[];
  }): Promise<number | undefined> {
    if (!args.couponCodes || args.couponCodes.length === 0) {
      return undefined;
    }

    const baseQuote = this.pricing.computeQuote(args.targetPlan, args.billingCycle);

    const resolution = await this.coupons.resolveCodes({
      codes: args.couponCodes,
      userId: args.userId,
      planId: String(args.targetPlan._id),
      billingCycle: args.billingCycle,
      basePricePaise: baseQuote.basePricePaise,
    });

    if (typeof resolution.discountOnBasePaise === 'number') {
      return Math.max(0, Math.round(resolution.discountOnBasePaise));
    }
    if (typeof resolution.finalTotalOverridePaise === 'number') {
      // fixed_price coupon — treat its effect as a base discount.
      return Math.max(0, Math.round(baseQuote.basePricePaise - resolution.finalTotalOverridePaise));
    }
    return undefined;
  }

  /**
   * Deep-clone a plan's entitlements, then overlay the `communications`
   * sub-object from a source (the live subscription's
   * `appliedEntitlements`) so the pre-paid SMS / WhatsApp credit
   * balances + auto-recharge config survive a plan swap.
   *
   * Both inputs may be hydrated Mongoose subdocuments — `plainClone`
   * normalises to a plain object first (`structuredClone` rejects a
   * Mongoose document outright), preserving `Date` fields such as
   * `communications.lastLowBalanceAlertAt`.
   */
  private cloneEntitlementsPreservingComms(
    planEntitlements: PlanEntitlements,
    sourceApplied: PlanEntitlements | undefined,
  ): PlanEntitlements {
    const cloned = this.plainClone(planEntitlements);
    const sourceComms = (sourceApplied as any)?.communications;
    if (sourceComms) {
      (cloned as any).communications = this.plainClone(sourceComms);
    }
    return cloned;
  }

  /**
   * Deep-clone a value to a plain JS object. Handles hydrated Mongoose
   * documents / subdocuments (via `.toObject()`) before `structuredClone`,
   * which throws a `DataCloneError` on a raw Mongoose document. Dates are
   * preserved (unlike a JSON round-trip).
   */
  private plainClone<T>(value: T): T {
    const plain =
      value && typeof (value as any).toObject === 'function' ? (value as any).toObject() : value;
    return structuredClone(plain) as T;
  }

  /** The Razorpay plan-mirror id for a plan + cycle, or undefined if not yet created. */
  private razorpayPlanIdFor(plan: Plan, cycle: BillingCycle): string | undefined {
    if (cycle === 'monthly') return plan.razorpayPlanIdMonthly ?? undefined;
    if (cycle === 'yearly') return plan.razorpayPlanIdYearly ?? undefined;
    return undefined;
  }

  /** First coupon code (uppercased) — stamped onto the quote, if any. */
  private firstCouponCode(codes?: string[]): string | undefined {
    if (!codes || codes.length === 0) return undefined;
    return codes[0]?.trim().toUpperCase() || undefined;
  }

  /**
   * Returns a NEW Date `from + one billing cycle`. Calendar-correct —
   * monthly adds one calendar month, yearly one calendar year. `from`
   * is never mutated.
   */
  private addCycle(from: Date, cycle: BillingCycle): Date {
    const next = new Date(from.getTime());
    if (cycle === 'yearly') {
      next.setFullYear(next.getFullYear() + 1);
    } else {
      next.setMonth(next.getMonth() + 1);
    }
    return next;
  }

  /**
   * Build a Razorpay-receipt string under their 40-char cap.
   * Format: `pc-<userId12>-<base36ts>` (max 3 + 12 + 1 + ~9 chars).
   */
  private buildReceipt(userId: string): string {
    const userTail = userId.slice(-12);
    const tsB36 = Date.now().toString(36);
    return `pc-${userTail}-${tsB36}`;
  }

  private toConfirmResult(payment: SubscriptionPayment): ConfirmPlanChangeResult {
    return {
      subscriptionId: payment.subscriptionId ? String(payment.subscriptionId) : '',
      paymentId: String(payment._id),
      appliedAt: payment.capturedAt ?? new Date(),
    };
  }
}
