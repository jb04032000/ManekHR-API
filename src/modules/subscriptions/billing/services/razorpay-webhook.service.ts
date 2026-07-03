import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RazorpayWebhookEvent } from '../schemas/razorpay-webhook-event.schema';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { Subscription } from '../../schemas/subscription.schema';
import { SubscriptionsService } from '../../subscriptions.service';
import { RazorpayPlatformService } from './razorpay-platform.service';
import { CouponService } from './coupon.service';
import { InvoiceService } from './invoice.service';
import { DunningService } from './dunning.service';
import { RefundService } from './refund.service';
import { AuditAction, AuditLogService } from './audit-log.service';
import { PlanChangeService } from './plan-change.service';
import { User } from '../../../users/schemas/user.schema';
import { Plan } from '../../schemas/plan.schema';

interface DispatchResult {
  status: 'processed' | 'ignored' | 'failed';
  message?: string;
}

/**
 * Razorpay webhook ingestion + dispatch.
 *
 * Defence-in-depth (D1d):
 *   1. HMAC-SHA256 signature verification gates entry — only Razorpay can
 *      sign with the dashboard-configured webhook secret.
 *   2. Raw event row is upserted before any business logic. The unique
 *      index on `eventId` rejects duplicate deliveries at write time —
 *      Razorpay retries up to ~24h on non-2xx responses, and an at-least-
 *      once guarantee means the same event WILL arrive multiple times.
 *   3. Each handler is idempotent: status guards on the underlying row
 *      prevent double-writes (e.g. payment.captured handler is a no-op
 *      when the SubscriptionPayment is already 'captured').
 *   4. Handler errors are captured on the event row but the controller
 *      still returns 200 — Razorpay retries on non-2xx and a buggy
 *      handler would loop the same broken event forever. Admin replay
 *      reads from the persisted raw body when needed.
 */
@Injectable()
export class RazorpayWebhookService {
  private readonly logger = new Logger(RazorpayWebhookService.name);

  constructor(
    @InjectModel(RazorpayWebhookEvent.name)
    private readonly eventModel: Model<RazorpayWebhookEvent>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptionsService: SubscriptionsService,
    private readonly razorpay: RazorpayPlatformService,
    private readonly coupons: CouponService,
    private readonly invoices: InvoiceService,
    private readonly dunning: DunningService,
    private readonly refundsService: RefundService,
    private readonly audit: AuditLogService,
    private readonly planChange: PlanChangeService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
  ) {}

  /**
   * Entry point — verify, persist, dispatch. Never throws; returns a
   * structured result the controller turns into a 200 response.
   */
  async ingest(rawBody: string, signature: string, eventIdHeader: string) {
    const verified = this.razorpay.verifyWebhookSignature(rawBody, signature);
    if (!verified) {
      // Don't persist invalid events — saves storage from spray attacks.
      this.logger.warn('Razorpay webhook rejected: invalid signature');
      return { ok: false as const, reason: 'invalid_signature' };
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.logger.warn('Razorpay webhook rejected: invalid JSON');
      return { ok: false as const, reason: 'invalid_json' };
    }

    const eventId =
      eventIdHeader || payload?.id || `${payload?.event}-${payload?.created_at ?? Date.now()}`;
    const eventType = payload?.event ?? 'unknown';

    // Persist raw FIRST — independent of dispatch outcome. Unique index on
    // eventId surfaces dup deliveries via duplicate-key error.
    let eventRow: RazorpayWebhookEvent;
    try {
      eventRow = await this.eventModel.create({
        eventId,
        eventType,
        signatureVerified: true,
        rawBody,
        payload,
        gatewayPaymentId: this.extractPaymentId(payload),
        gatewayOrderId: this.extractOrderId(payload),
        gatewaySubscriptionId: this.extractSubscriptionId(payload),
        status: 'processing',
      });
    } catch (err: any) {
      // Duplicate eventId → already processed (or in flight). 200 OK so
      // Razorpay stops retrying.
      if (err?.code === 11000) {
        this.logger.log(`Razorpay webhook duplicate delivery ignored: eventId=${eventId}`);
        return { ok: true as const, duplicate: true };
      }
      this.logger.error(`Razorpay webhook persist failed: ${err?.message ?? err}`);
      // Re-throw so controller returns 500 → Razorpay will retry once we
      // recover. Persistence failure is the only retriable surface.
      throw err;
    }

    // Dispatch.
    let result: DispatchResult;
    try {
      result = await this.dispatch(eventType, payload);
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).slice(0, 500);
      this.logger.error(`Razorpay webhook handler failed event=${eventType} id=${eventId}: ${msg}`);
      result = { status: 'failed', message: msg };
    }

    await this.eventModel
      .updateOne(
        { _id: eventRow._id },
        {
          $set: {
            status: result.status,
            processedAt: new Date(),
            errorMessage: result.message,
          },
        },
      )
      .exec();

    return { ok: true as const, eventId, status: result.status };
  }

  // ── dispatch ────────────────────────────────────────────────────────

  private async dispatch(eventType: string, payload: any): Promise<DispatchResult> {
    switch (eventType) {
      case 'payment.captured':
        return this.handlePaymentCaptured(payload);
      case 'payment.failed':
        return this.handlePaymentFailed(payload);
      case 'refund.created':
      case 'refund.processed':
        return this.handleRefund(payload);
      case 'subscription.activated':
        return this.handleSubscriptionActivated(payload);
      case 'subscription.charged':
        return this.handleSubscriptionCharged(payload);
      case 'subscription.halted':
        return this.handleSubscriptionHalted(payload);
      case 'subscription.cancelled':
        return this.handleSubscriptionCancelled(payload);
      case 'subscription.paused':
        return this.handleSubscriptionPaused(payload);
      case 'subscription.resumed':
        return this.handleSubscriptionResumed(payload);
      case 'subscription.completed':
      case 'subscription.expired':
        return this.handleSubscriptionExpired(payload);
      case 'payment_link.paid':
        return this.handlePaymentLinkPaid(payload);
      case 'payment_link.cancelled':
      case 'payment_link.expired':
        return this.handlePaymentLinkClosed(payload);
      default:
        this.logger.log(`Razorpay webhook ignored: ${eventType}`);
        return { status: 'ignored' };
    }
  }

  /**
   * `payment.captured` — money is in. Paths:
   *   1. Client already called `/checkout/confirm` (or `/change-plan/confirm`)
   *      → SubscriptionPayment is already 'captured'. No-op (status guard
   *      short-circuits).
   *   2. Client closed a CHECKOUT tab mid-flow → row still 'created',
   *      `context='checkout'`. Transition it to captured and create the
   *      Subscription so the user gets what they paid for. Closes the
   *      abandoned-tab gap that D1b alone has.
   *   3. Client closed a PLAN-CHANGE tab mid-flow → row still 'created',
   *      `context='plan_change'`. Transition it to captured, then delegate
   *      to `PlanChangeService.applyCapturedPlanChangePayment` which applies
   *      the upgrade in place on the existing subscription (no new row).
   *
   * The atomic `created → captured` claim below is the exactly-once gate
   * shared with both `/confirm` paths: whoever wins the transition performs
   * the apply; a concurrent `/confirm` that loses returns idempotently.
   */
  private async handlePaymentCaptured(payload: any): Promise<DispatchResult> {
    const entity = payload?.payload?.payment?.entity;
    const orderId = entity?.order_id;
    const paymentId = entity?.id;
    if (!orderId || !paymentId) {
      return { status: 'ignored', message: 'missing order_id/payment_id' };
    }

    const payment = await this.paymentModel
      .findOne({ gatewayOrderId: orderId, gateway: 'razorpay' })
      .exec();
    if (!payment) {
      // Webhook arrived before our SubscriptionPayment row exists. Razorpay
      // will retry — by the next attempt the row should exist. Returning
      // 'ignored' marks event processed; if the gap persists, admin can
      // replay from the raw event log.
      return { status: 'ignored', message: 'no payment row for order' };
    }

    if (payment.status === 'captured' && payment.subscriptionId) {
      return { status: 'processed', message: 'already captured' };
    }

    if (payment.status !== 'created') {
      return {
        status: 'ignored',
        message: `payment in non-capturable state: ${payment.status}`,
      };
    }

    const captured = await this.paymentModel
      .findOneAndUpdate(
        { _id: payment._id, status: 'created' },
        {
          $set: {
            status: 'captured',
            gatewayPaymentId: paymentId,
            capturedAt: new Date(),
            attemptNumber: 1,
          },
        },
        { new: true },
      )
      .exec();

    if (!captured) {
      // A concurrent /confirm beat us to it. Re-read; if subscription is
      // now linked we're done.
      const reread = await this.paymentModel.findById(payment._id).exec();
      if (reread?.status === 'captured' && reread.subscriptionId) {
        return { status: 'processed', message: 'raced /confirm' };
      }
      return { status: 'failed', message: 'transition lost without subscription' };
    }

    // ── plan-change path ────────────────────────────────────────────────
    // Abandoned-tab recovery for a customer change-plan upgrade. The row is
    // now captured (we won the claim above — `/change-plan/confirm` cannot
    // also reach the apply). Delegate to PlanChangeService, which applies
    // the upgrade IN PLACE on the existing subscription. Do NOT run the
    // checkout `subscribe()` path — that would supersede + recreate.
    //
    // Wrapped in try/catch: a late / replayed webhook must never 500
    // (Razorpay would retry the same event for ~24h). The apply is
    // idempotent — `applyCapturedPlanChangePayment` short-circuits once the
    // payment is linked to a subscription — so swallowing-and-logging here
    // mirrors how the rest of this service treats non-retriable handler
    // errors: the event row records the failure, admin can replay.
    if (captured.context === 'plan_change') {
      try {
        const result = await this.planChange.applyCapturedPlanChangePayment(String(captured._id));
        this.logger.log(
          `Webhook payment.captured (plan_change) user=${String(captured.userId)} payment=${String(captured._id)} sub=${result.subscriptionId}`,
        );
        return { status: 'processed', message: 'plan change applied' };
      } catch (err) {
        this.logger.error(
          `Webhook plan-change apply failed payment=${String(captured._id)}: ${(err as Error).message}`,
        );
        // Still report processed-with-error rather than re-raising — the
        // payment is captured + the event row carries the message; a 500
        // would only loop Razorpay's retry on an error our apply already
        // logged. Returning 'failed' surfaces it to admin replay tooling.
        return {
          status: 'failed',
          message: `plan-change apply failed: ${(err as Error).message}`,
        };
      }
    }

    // ── checkout path (context='checkout', unchanged) ───────────────────
    const subscription = await this.subscriptionsService.subscribe(String(captured.userId), {
      planId: String(captured.planId),
      billingCycle: captured.billingCycle,
      activateImmediately: true,
    });

    await this.subscriptionModel
      .findByIdAndUpdate(subscription._id, {
        $set: {
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          source: 'self',
        },
      })
      .exec();

    captured.subscriptionId = subscription._id;
    await captured.save();

    // Backfill billing snapshot if missing — defensive against pre-D1f
    // payment rows or any path that skipped the snapshot at create.
    if (!captured.billingSnapshot) {
      const user = await this.userModel
        .findById(captured.userId)
        .select('name email mobile billingProfile')
        .exec();
      if (user) {
        captured.billingSnapshot = InvoiceService.buildBillingSnapshot(user.toObject());
        await captured.save();
      }
    }

    // Record coupon redemption(s) when this capture closed an
    // abandoned-tab gap — the regular /confirm path also records, but
    // the webhook path is the only one that runs when the user never
    // returns to the app.
    if (captured.appliedCouponCode) {
      try {
        const codes = captured.appliedCouponCode.split(',').filter(Boolean);
        const replay = await this.coupons.resolveCodes({
          codes,
          userId: String(captured.userId),
          planId: String(captured.planId),
          billingCycle: captured.billingCycle as 'monthly' | 'yearly',
          basePricePaise: captured.planPricePaise,
        });
        await this.coupons.recordRedemptions({
          payment: captured,
          resolved: replay.resolved,
          userId: String(captured.userId),
        });
      } catch (err) {
        this.logger.warn(
          `Webhook coupon redemption record failed payment=${String(captured._id)} err=${(err as Error).message}`,
        );
      }
    }

    // Generate invoice (D1f). Async + isolated from this handler's
    // success — the user gets their subscription regardless of PDF
    // pipeline health; download endpoint is the recovery path.
    this.invoices
      .generate(String(captured._id))
      .catch((err) =>
        this.logger.warn(
          `Webhook invoice generation failed payment=${String(captured._id)} err=${(err as Error).message}`,
        ),
      );

    this.logger.log(
      `Webhook payment.captured user=${String(captured.userId)} payment=${String(captured._id)} sub=${String(subscription._id)}`,
    );
    await this.audit.log({
      action: AuditAction.WebhookPaymentCaptured,
      actorType: 'webhook',
      targetUserId: String(captured.userId),
      paymentId: String(captured._id),
      subscriptionId: String(subscription._id),
      metadata: { gatewayPaymentId: paymentId, gatewayOrderId: orderId },
    });
    return { status: 'processed' };
  }

  private async handlePaymentFailed(payload: any): Promise<DispatchResult> {
    const entity = payload?.payload?.payment?.entity;
    const orderId = entity?.order_id;
    if (!orderId) return { status: 'ignored', message: 'missing order_id' };

    const reason = entity?.error_description ?? entity?.error_reason ?? 'unknown';

    const updated = await this.paymentModel
      .findOneAndUpdate(
        {
          gatewayOrderId: orderId,
          gateway: 'razorpay',
          status: { $in: ['created', 'authorised'] },
        },
        {
          $set: {
            status: 'failed',
            failureReason: String(reason).slice(0, 500),
            failedAt: new Date(),
          },
        },
      )
      .exec();

    if (updated) {
      await this.audit.log({
        action: AuditAction.WebhookPaymentFailed,
        actorType: 'webhook',
        targetUserId: String(updated.userId),
        paymentId: String(updated._id),
        metadata: { reason: String(reason).slice(0, 200), gatewayOrderId: orderId },
      });
    }
    return updated
      ? { status: 'processed' }
      : { status: 'ignored', message: 'no eligible payment row' };
  }

  private async handleRefund(payload: any): Promise<DispatchResult> {
    const refund = payload?.payload?.refund?.entity;
    const refundId = refund?.id;
    const paymentId = refund?.payment_id;
    if (!refundId || !paymentId) {
      return { status: 'ignored', message: 'missing refund id / payment id' };
    }

    const payment = await this.paymentModel.findOne({ gatewayPaymentId: paymentId }).exec();
    if (!payment) {
      return { status: 'ignored', message: 'no payment for refund' };
    }

    // Idempotent: skip if refund id already present.
    if (payment.refunds?.some((r) => r.refundId === refundId)) {
      return { status: 'processed', message: 'already recorded' };
    }

    const amountPaise = Number(refund?.amount ?? 0);
    payment.refunds.push({
      refundId,
      amountPaise,
      status: refund?.status === 'processed' ? 'processed' : 'pending',
      reason: refund?.notes?.reason,
      initiatedAt: new Date(),
      processedAt: refund?.status === 'processed' ? new Date() : undefined,
    });

    const totalRefunded = payment.refunds.reduce((sum, r) => sum + (r.amountPaise ?? 0), 0);
    if (totalRefunded >= payment.totalPaise) {
      payment.status = 'refunded';
    } else if (totalRefunded > 0) {
      payment.status = 'partially_refunded';
    }

    await payment.save();

    // D1h — sync RefundRequest state from gateway. The dispatcher fires
    // for both `refund.created` (status=pending) and `refund.processed`
    // (terminal). Only the terminal events should flip the request row
    // to `processed`/`failed`; intermediate pending events are no-ops.
    const isTerminal = refund?.status === 'processed' || refund?.status === 'failed';
    if (isTerminal) {
      await this.refundsService
        .syncFromWebhook({
          gatewayRefundId: refundId,
          status: refund.status,
          failureReason: refund?.error_description,
        })
        .catch((err) =>
          this.logger.warn(
            `Refund request sync failed refundId=${refundId} err=${(err as Error).message}`,
          ),
        );
      await this.audit.log({
        action:
          refund.status === 'processed'
            ? AuditAction.WebhookRefundProcessed
            : AuditAction.WebhookRefundFailed,
        actorType: 'webhook',
        targetUserId: String(payment.userId),
        paymentId: String(payment._id),
        metadata: {
          gatewayRefundId: refundId,
          amountPaise,
          failureReason: refund?.error_description,
        },
      });
    }

    return { status: 'processed' };
  }

  /**
   * `subscription.activated` (D1c) — Razorpay confirms the mandate's
   * authorisation payment cleared. Two responsibilities:
   *   1. Flip the local `pending` Subscription to `active` and stamp
   *      the period bounds from Razorpay's clock (gateway is the
   *      system-of-record for billing periods, so use rzp `current_start`
   *      / `current_end` rather than locally-computed dates).
   *   2. Supersede the user's existing `active` / `trial` subscription —
   *      we deliberately deferred this from `/checkout/mandate` so a
   *      failed auth payment didn't cost the user their existing access.
   *
   * Idempotent: re-running on an already-active row is a no-op (status
   * filter excludes 'active', 'cancelled', 'expired'); supersession of
   * an already-superseded row is filtered out by the same guard.
   *
   * Webhook ordering: Razorpay does NOT guarantee `activated` arrives
   * before `charged`. The charged handler also accepts a `pending` row
   * and treats first charge as activation, so this handler being slow
   * is safe.
   */
  private async handleSubscriptionActivated(payload: any): Promise<DispatchResult> {
    const entity = payload?.payload?.subscription?.entity;
    const subId = entity?.id;
    if (!subId) return { status: 'ignored', message: 'missing subscription id' };

    const sub = await this.subscriptionModel.findOne({ razorpaySubscriptionId: subId }).exec();
    if (!sub) {
      return { status: 'ignored', message: 'no local subscription for id' };
    }

    if (sub.status === 'active') {
      return { status: 'processed', message: 'already active' };
    }
    if (['cancelled', 'expired', 'superseded'].includes(sub.status)) {
      return {
        status: 'ignored',
        message: `non-activatable status: ${sub.status}`,
      };
    }

    const periodStart = entity?.current_start ? new Date(entity.current_start * 1000) : new Date();
    const periodEnd = entity?.current_end ? new Date(entity.current_end * 1000) : null;

    // Atomic activation transition.
    const activated = await this.subscriptionModel
      .findOneAndUpdate(
        { _id: sub._id, status: { $nin: ['active', 'cancelled', 'expired', 'superseded'] } },
        {
          $set: {
            status: 'active',
            currentPeriodStart: periodStart,
            ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
            failedPaymentAttempts: 0,
            gracePeriodUntil: null,
          },
        },
        { new: true },
      )
      .exec();
    if (!activated) {
      return { status: 'processed', message: 'concurrent activation' };
    }

    // Supersede any prior active/trial subscription for the same user.
    // Workspace boundary respected — supersede only the matching scope
    // (account-level or same workspace-id).
    const supersedeQuery: any = {
      userId: activated.userId,
      _id: { $ne: activated._id },
      status: { $in: ['active', 'trial', 'past_due', 'grace_period'] },
    };
    if (activated.workspaceId) {
      supersedeQuery.workspaceId = activated.workspaceId;
    } else {
      supersedeQuery.$or = [{ workspaceId: null }, { workspaceId: { $exists: false } }];
    }
    const superseded = await this.subscriptionModel
      .updateMany(supersedeQuery, {
        $set: {
          status: 'superseded',
          previousSubscriptionId: activated._id,
        },
      })
      .exec();

    this.logger.log(
      `subscription.activated user=${String(activated.userId)} sub=${String(activated._id)} rzp=${subId} superseded=${superseded.modifiedCount}`,
    );
    await this.audit.log({
      action: AuditAction.WebhookSubscriptionActivated,
      actorType: 'webhook',
      targetUserId: String(activated.userId),
      subscriptionId: String(activated._id),
      metadata: {
        razorpaySubscriptionId: subId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        supersededCount: superseded.modifiedCount,
      },
    });
    return { status: 'processed' };
  }

  /**
   * `subscription.charged` (D1c) — recurring debit cleared. Per-cycle
   * actions:
   *   1. Locate the local Subscription by `razorpaySubscriptionId`.
   *      Reject if missing (return 'ignored' — admin can replay later).
   *   2. Insert a `recurring/captured` SubscriptionPayment row stamped
   *      with the gateway payment id. Idempotency: dup-key on
   *      `gatewayPaymentId` unique index → return 'processed' (Razorpay
   *      WILL retry deliveries; this is the authoritative dedup gate).
   *   3. Extend `currentPeriodStart/End` from Razorpay's clock — the
   *      gateway is the source of truth (avoids drift across months).
   *   4. Recovery from `past_due` / `grace_period` → flip back to
   *      `active`, reset failedPaymentAttempts, clear gracePeriodUntil.
   *   5. If the local row is still `pending` (charged arrived before
   *      activated), treat first charge as activation: same field
   *      writes, plus supersede prior active sub for the same user.
   *
   * Does NOT call `subscriptionsService.subscribe()` — that path
   * supersedes/recreates and would corrupt the mandate-bound row.
   */
  private async handleSubscriptionCharged(payload: any): Promise<DispatchResult> {
    const subEntity = payload?.payload?.subscription?.entity;
    const paymentEntity = payload?.payload?.payment?.entity;
    const subId = subEntity?.id;
    const paymentId = paymentEntity?.id;
    if (!subId || !paymentId) {
      return {
        status: 'ignored',
        message: 'missing subscription or payment id',
      };
    }

    const sub = await this.subscriptionModel.findOne({ razorpaySubscriptionId: subId }).exec();
    if (!sub) {
      return { status: 'ignored', message: 'no local subscription for id' };
    }
    if (['cancelled', 'expired', 'superseded'].includes(sub.status)) {
      return {
        status: 'ignored',
        message: `non-chargeable status: ${sub.status}`,
      };
    }

    // Look up the mandate's seed payment row (status=created, no
    // gatewayPaymentId yet) — created at /checkout/mandate time. Carries
    // the coupon snapshot for the FIRST CYCLE only (cycles 2+ revert to
    // standard plan + no discount).
    const seedPayment = await this.paymentModel
      .findOne({
        gatewaySubscriptionId: subId,
        paymentMode: 'recurring',
        status: 'created',
      })
      .sort({ createdAt: 1 })
      .exec();

    const isFirstCycle = (sub.failedPaymentAttempts ?? 0) === 0 && sub.status === 'pending';

    // Insert payment row — dup-key on gatewayPaymentId is the
    // authoritative idempotency gate against retried deliveries.
    const amountPaise = Number(paymentEntity?.amount ?? 0);

    // Carry billing snapshot forward from the seed payment so every
    // recurring invoice renders consistent recipient details. If the
    // seed is missing one (defensive), pull a fresh snapshot from User.
    let billingSnapshot = seedPayment?.billingSnapshot;
    if (!billingSnapshot) {
      const user = await this.userModel
        .findById(sub.userId)
        .select('name email mobile billingProfile')
        .exec();
      if (user) {
        billingSnapshot = InvoiceService.buildBillingSnapshot(user.toObject());
      }
    }

    // Recompute GST breakdown locally for the recurring charge so the
    // invoice reflects accurate CGST/SGST/IGST split. Razorpay-side
    // plan was mirrored at GST-inclusive total; reverse-compute the
    // base + tax from the charged amount using the local Plan's rate.
    // The full Plan doc (no projection) carries `gstEnabled`, so the
    // optional-GST gate below sees it. Keep the gate in sync with
    // PricingService.computeQuote — that is the canonical predicate.
    const planForGst = await this.planModel.findById(sub.planId).exec();
    // Persist only rate + tax portion; the charged amount itself is stored as
    // planPricePaise/totalPaise below. taxableBase isn't persisted here.
    const { gstRatePercent: gstRate, gstPortion } = this.computeRecurringChargeGst(
      planForGst,
      amountPaise,
    );

    let chargedPayment: SubscriptionPayment | null = null;
    try {
      chargedPayment = await this.paymentModel.create({
        userId: sub.userId,
        subscriptionId: sub._id,
        planId: sub.planId,
        billingCycle: sub.billingCycle,
        paymentMode: 'recurring',
        status: 'captured',
        gateway: 'razorpay',
        gatewaySubscriptionId: subId,
        gatewayPaymentId: paymentId,
        // Mandate plan was mirrored at GST-inclusive total — store the
        // charged amount + reverse-computed tax breakdown for invoicing.
        planPricePaise: amountPaise,
        discountPaise: 0,
        gstPaise: gstPortion,
        gstRatePercent: gstRate,
        totalPaise: amountPaise,
        ...(billingSnapshot ? { billingSnapshot } : {}),
        capturedAt: paymentEntity?.captured_at
          ? new Date(paymentEntity.captured_at * 1000)
          : new Date(),
        attemptNumber: (sub.failedPaymentAttempts ?? 0) + 1,
        // First-cycle coupon snapshot pulled from the seed row so the
        // CouponRedemption record carries the correct coupon code(s).
        ...(isFirstCycle && seedPayment?.appliedCouponCode
          ? {
              appliedCouponId: seedPayment.appliedCouponId,
              appliedCouponCode: seedPayment.appliedCouponCode,
              discountPaise: seedPayment.discountPaise,
            }
          : {}),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        return { status: 'processed', message: 'duplicate payment id' };
      }
      throw err;
    }

    // Mark the seed row consumed once the first charge lands so the
    // reuse-window dedup in createMandate doesn't keep matching it.
    if (isFirstCycle && seedPayment) {
      await this.paymentModel
        .updateOne({ _id: seedPayment._id, status: 'created' }, { $set: { status: 'authorised' } })
        .exec();
    }

    // Record coupon redemption for first cycle only — cycles 2+ are
    // post-revert and have no discount.
    if (isFirstCycle && seedPayment?.appliedCouponCode) {
      try {
        const codes = seedPayment.appliedCouponCode.split(',').filter(Boolean);
        const replay = await this.coupons.resolveCodes({
          codes,
          userId: String(sub.userId),
          planId: String(sub.planId),
          billingCycle: sub.billingCycle as 'monthly' | 'yearly',
          basePricePaise: seedPayment.planPricePaise,
        });
        await this.coupons.recordRedemptions({
          payment: chargedPayment,
          resolved: replay.resolved,
          userId: String(sub.userId),
        });
      } catch (err) {
        this.logger.warn(
          `Mandate first-cycle coupon redemption record failed payment=${String(chargedPayment._id)} err=${(err as Error).message}`,
        );
      }
    }

    // Period extension + recovery from past_due. Use Razorpay clock as
    // source of truth.
    const periodStart = subEntity?.current_start
      ? new Date(subEntity.current_start * 1000)
      : new Date();
    const periodEnd = subEntity?.current_end ? new Date(subEntity.current_end * 1000) : null;

    const wasPending = sub.status === 'pending';

    await this.subscriptionModel
      .updateOne(
        { _id: sub._id, status: { $nin: ['cancelled', 'expired', 'superseded'] } },
        {
          $set: {
            status: 'active',
            currentPeriodStart: periodStart,
            ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
            failedPaymentAttempts: 0,
          },
          $unset: { gracePeriodUntil: '' },
        },
      )
      .exec();

    // First charge before `activated` arrived — also do supersession.
    if (wasPending) {
      const supersedeQuery: any = {
        userId: sub.userId,
        _id: { $ne: sub._id },
        status: { $in: ['active', 'trial', 'past_due', 'grace_period'] },
      };
      if (sub.workspaceId) {
        supersedeQuery.workspaceId = sub.workspaceId;
      } else {
        supersedeQuery.$or = [{ workspaceId: null }, { workspaceId: { $exists: false } }];
      }
      await this.subscriptionModel
        .updateMany(supersedeQuery, {
          $set: {
            status: 'superseded',
            previousSubscriptionId: sub._id,
          },
        })
        .exec();
    }

    // D1g — recovery notification. The status flip + dunning-field
    // reset above already restored the subscription to active. Just
    // fire the "back on track" email so the customer knows.
    if (sub.status === 'grace_period' || sub.status === 'past_due') {
      await this.dunning
        .notifyRecovery(String(sub._id))
        .catch((err) =>
          this.logger.warn(
            `Recovery notify failed sub=${String(sub._id)} err=${(err as Error).message}`,
          ),
        );
    }

    // Generate the recurring-cycle invoice (D1f). Async — never fail
    // a webhook over a PDF/storage hiccup.
    if (chargedPayment) {
      this.invoices
        .generate(String(chargedPayment._id))
        .catch((err) =>
          this.logger.warn(
            `Recurring invoice generation failed payment=${String(chargedPayment._id)} err=${(err as Error).message}`,
          ),
        );
    }

    this.logger.log(
      `subscription.charged user=${String(sub.userId)} sub=${String(sub._id)} rzp=${subId} payment=${paymentId} amount=${amountPaise}`,
    );
    await this.audit.log({
      action: AuditAction.WebhookSubscriptionCharged,
      actorType: 'webhook',
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      paymentId: chargedPayment ? String(chargedPayment._id) : undefined,
      metadata: {
        razorpaySubscriptionId: subId,
        gatewayPaymentId: paymentId,
        amountPaise,
        wasFirstCycle: isFirstCycle,
      },
    });
    return { status: 'processed' };
  }

  /**
   * Reverse-compute the GST split for a recurring auto-renew charge from the
   * GST-inclusive amount Razorpay charged the mandate.
   *
   * Honours the optional-GST gate (Task 3 — `Plan.gstEnabled`). The predicate
   * MUST stay in sync with PricingService.computeQuote, the canonical gate:
   * GST is ON unless EXPLICITLY false (undefined = pre-field plan = ON,
   * back-compat). When disabled we force rate 0, take the whole charge as the
   * taxable base and carve NO tax — otherwise a `gstEnabled=false` plan would
   * stamp a phantom 18% on every renewal invoice and the PDF would render
   * bogus CGST/SGST rows.
   */
  private computeRecurringChargeGst(
    planForGst: Plan | null,
    amountPaise: number,
  ): { gstRatePercent: number; taxableBase: number; gstPortion: number } {
    const gstEnabled = planForGst?.gstEnabled !== false;
    if (!gstEnabled) {
      return { gstRatePercent: 0, taxableBase: amountPaise, gstPortion: 0 };
    }
    const gstRatePercent = planForGst?.gstRatePercent ?? 18;
    const denominator = 1 + gstRatePercent / 100;
    const taxableBase = Math.round(amountPaise / denominator);
    const gstPortion = amountPaise - taxableBase;
    return { gstRatePercent, taxableBase, gstPortion };
  }

  /**
   * `subscription.halted` (D1d/D1g) — Razorpay has exhausted its retry
   * attempts and stopped trying to charge the mandate. Hand off to
   * `DunningService.enterGrace` which sets `status='grace_period'`,
   * stamps `gracePeriodUntil`, dispatches the dunning email, and
   * schedules the reminder + expiry jobs via BullMQ.
   */
  private async handleSubscriptionHalted(payload: any): Promise<DispatchResult> {
    const subId = payload?.payload?.subscription?.entity?.id;
    if (!subId) return { status: 'ignored', message: 'missing subscription id' };

    const sub = await this.subscriptionModel.findOne({ razorpaySubscriptionId: subId }).exec();
    if (!sub) {
      return { status: 'ignored', message: 'no local subscription for id' };
    }
    if (['cancelled', 'expired', 'superseded'].includes(sub.status)) {
      return {
        status: 'ignored',
        message: `non-haltable status: ${sub.status}`,
      };
    }

    await this.dunning.enterGrace(String(sub._id));
    await this.audit.log({
      action: AuditAction.WebhookSubscriptionHalted,
      actorType: 'webhook',
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: { razorpaySubscriptionId: subId },
    });
    return { status: 'processed' };
  }

  private async handleSubscriptionCancelled(payload: any): Promise<DispatchResult> {
    const subId = payload?.payload?.subscription?.entity?.id;
    if (!subId) return { status: 'ignored', message: 'missing subscription id' };

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        { razorpaySubscriptionId: subId, status: { $ne: 'cancelled' } },
        {
          $set: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancellationReason: 'razorpay_subscription_cancelled',
          },
        },
      )
      .exec();

    if (updated) {
      await this.audit.log({
        action: AuditAction.WebhookSubscriptionCancelled,
        actorType: 'webhook',
        targetUserId: String(updated.userId),
        subscriptionId: String(updated._id),
        metadata: { razorpaySubscriptionId: subId },
      });
    }
    return updated
      ? { status: 'processed' }
      : { status: 'ignored', message: 'no eligible subscription' };
  }

  /**
   * `subscription.paused` — Razorpay confirms a pause request took
   * effect. Idempotent: re-applying to an already-paused row is a no-op.
   */
  private async handleSubscriptionPaused(payload: any): Promise<DispatchResult> {
    const subId = payload?.payload?.subscription?.entity?.id;
    if (!subId) return { status: 'ignored', message: 'missing subscription id' };

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        {
          razorpaySubscriptionId: subId,
          status: { $nin: ['paused', 'cancelled', 'expired', 'superseded'] },
        },
        {
          $set: {
            status: 'paused',
            isPaused: true,
            pausedAt: new Date(),
          },
        },
      )
      .exec();

    if (updated) {
      await this.audit.log({
        action: AuditAction.WebhookSubscriptionPaused,
        actorType: 'webhook',
        targetUserId: String(updated.userId),
        subscriptionId: String(updated._id),
        metadata: { razorpaySubscriptionId: subId },
      });
    }
    return updated
      ? { status: 'processed' }
      : { status: 'ignored', message: 'no eligible subscription' };
  }

  /**
   * `subscription.resumed` — Razorpay confirms a resume request took
   * effect. Flip back to `active`; subsequent `subscription.charged`
   * events will continue extending the period.
   */
  private async handleSubscriptionResumed(payload: any): Promise<DispatchResult> {
    const subId = payload?.payload?.subscription?.entity?.id;
    if (!subId) return { status: 'ignored', message: 'missing subscription id' };

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        {
          razorpaySubscriptionId: subId,
          status: 'paused',
        },
        {
          $set: {
            status: 'active',
            isPaused: false,
          },
          $unset: { pausedAt: '', pauseReason: '', resumeAt: '' },
        },
      )
      .exec();

    if (updated) {
      await this.audit.log({
        action: AuditAction.WebhookSubscriptionResumed,
        actorType: 'webhook',
        targetUserId: String(updated.userId),
        subscriptionId: String(updated._id),
        metadata: { razorpaySubscriptionId: subId },
      });
    }
    return updated
      ? { status: 'processed' }
      : { status: 'ignored', message: 'no paused subscription to resume' };
  }

  /**
   * `payment_link.paid` (D1i) — admin-issued payment link succeeded.
   * Locate the seed `SubscriptionPayment{paymentMode:'one_time',
   * source:'paid_link', gatewayPaymentLinkId}` row created at link-
   * issue time, mark it captured, and create the local Subscription
   * via the existing `subscribe()` helper. Mirrors the abandoned-tab
   * recovery path on payment.captured but keyed on payment-link id.
   *
   * Idempotent: status guard on the seed row + dup-key guard on the
   * Subscription's gatewayPaymentId (existing unique-sparse).
   */
  private async handlePaymentLinkPaid(payload: any): Promise<DispatchResult> {
    const linkEntity = payload?.payload?.payment_link?.entity;
    const paymentEntity = payload?.payload?.payment?.entity;
    const linkId = linkEntity?.id;
    const paymentId = paymentEntity?.id;
    if (!linkId || !paymentId) {
      return {
        status: 'ignored',
        message: 'missing payment_link or payment id',
      };
    }

    const seed = await this.paymentModel
      .findOne({
        gatewayPaymentLinkId: linkId,
        gateway: 'razorpay',
        paymentMode: 'one_time',
      })
      .exec();
    if (!seed) {
      return { status: 'ignored', message: 'no seed payment for link' };
    }

    if (seed.status === 'captured' && seed.subscriptionId) {
      return { status: 'processed', message: 'already captured' };
    }
    if (seed.status !== 'created') {
      return {
        status: 'ignored',
        message: `non-capturable status: ${seed.status}`,
      };
    }

    const captured = await this.paymentModel
      .findOneAndUpdate(
        { _id: seed._id, status: 'created' },
        {
          $set: {
            status: 'captured',
            gatewayPaymentId: paymentId,
            capturedAt: paymentEntity?.captured_at
              ? new Date(paymentEntity.captured_at * 1000)
              : new Date(),
            attemptNumber: 1,
          },
        },
        { new: true },
      )
      .exec();
    if (!captured) {
      return { status: 'ignored', message: 'concurrent capture' };
    }

    const subscription = await this.subscriptionsService.subscribe(String(captured.userId), {
      planId: String(captured.planId),
      billingCycle: captured.billingCycle,
      activateImmediately: true,
    });

    await this.subscriptionModel
      .findByIdAndUpdate(subscription._id, {
        $set: {
          razorpayPaymentId: paymentId,
          source: 'paid_link',
        },
      })
      .exec();

    captured.subscriptionId = subscription._id;
    await captured.save();

    // Fire invoice generation (D1f) — same path as /confirm + payment.captured.
    this.invoices
      .generate(String(captured._id))
      .catch((err) =>
        this.logger.warn(
          `Payment-link invoice generation failed payment=${String(captured._id)} err=${(err as Error).message}`,
        ),
      );

    this.logger.log(
      `payment_link.paid user=${String(captured.userId)} payment=${String(captured._id)} sub=${String(subscription._id)} link=${linkId}`,
    );
    await this.audit.log({
      action: AuditAction.WebhookPaymentLinkPaid,
      actorType: 'webhook',
      targetUserId: String(captured.userId),
      paymentId: String(captured._id),
      subscriptionId: String(subscription._id),
      metadata: {
        razorpayPaymentLinkId: linkId,
        gatewayPaymentId: paymentId,
      },
    });
    return { status: 'processed' };
  }

  /**
   * `payment_link.cancelled` / `payment_link.expired` — terminate the
   * seed `SubscriptionPayment` row so the customer can't trip a stale
   * resubmit. Idempotent — only flips rows still in `created`.
   */
  private async handlePaymentLinkClosed(payload: any): Promise<DispatchResult> {
    const linkId = payload?.payload?.payment_link?.entity?.id;
    if (!linkId) return { status: 'ignored', message: 'missing link id' };
    const updated = await this.paymentModel
      .findOneAndUpdate(
        {
          gatewayPaymentLinkId: linkId,
          status: 'created',
        },
        {
          $set: {
            status: 'failed',
            failureReason: 'payment_link_closed_without_payment',
            failedAt: new Date(),
          },
        },
      )
      .exec();
    return updated
      ? { status: 'processed' }
      : { status: 'ignored', message: 'no eligible row for link' };
  }

  /**
   * `subscription.completed` / `subscription.expired` — total_count
   * cycles consumed or end_at reached. Mark `expired` so the user
   * stops receiving entitlements; admin / dunning can offer a renewal.
   */
  private async handleSubscriptionExpired(payload: any): Promise<DispatchResult> {
    const subId = payload?.payload?.subscription?.entity?.id;
    if (!subId) return { status: 'ignored', message: 'missing subscription id' };

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        {
          razorpaySubscriptionId: subId,
          status: { $nin: ['cancelled', 'expired', 'superseded'] },
        },
        { $set: { status: 'expired' } },
      )
      .exec();

    return updated
      ? { status: 'processed' }
      : { status: 'ignored', message: 'no eligible subscription' };
  }

  // ── payload extraction (defensive — Razorpay schemas vary by event) ──

  private extractPaymentId(payload: any): string | undefined {
    return payload?.payload?.payment?.entity?.id ?? payload?.payload?.refund?.entity?.payment_id;
  }

  private extractOrderId(payload: any): string | undefined {
    return payload?.payload?.payment?.entity?.order_id;
  }

  private extractSubscriptionId(payload: any): string | undefined {
    return (
      payload?.payload?.subscription?.entity?.id ??
      payload?.payload?.payment?.entity?.subscription_id
    );
  }
}
