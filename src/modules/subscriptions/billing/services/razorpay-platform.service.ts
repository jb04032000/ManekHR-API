import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';

interface CreateOrderArgs {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

interface CreateOrderResult {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

interface VerifyArgs {
  orderId: string;
  paymentId: string;
  signature: string;
}

interface CreateCustomerArgs {
  name?: string;
  email?: string;
  contact?: string;
  gstin?: string;
  notes?: Record<string, string>;
  /** When true, reuse an existing customer matching email/contact instead of erroring. */
  failExisting?: boolean;
}

interface CreateCustomerResult {
  id: string;
  entity: string;
  email?: string;
  contact?: string;
}

interface CreatePlanArgs {
  amountPaise: number;
  currency?: string;
  name: string;
  description?: string;
  /** Razorpay billing period. monthly/yearly are the SaaS norm. */
  period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  notes?: Record<string, string>;
}

interface CreatePlanResult {
  id: string;
  entity: string;
  period: string;
  interval: number;
}

interface CreateSubscriptionArgs {
  planId: string;
  totalCount: number;
  customerNotify?: 0 | 1;
  quantity?: number;
  notes?: Record<string, string>;
}

interface CreateSubscriptionResult {
  id: string;
  status: string;
  shortUrl: string;
  customerId: string | null;
  currentStart: number | null;
  currentEnd: number | null;
  chargeAt: number;
  startAt: number;
  endAt: number;
  paidCount: number;
  remainingCount: string;
}

/**
 * Structured Razorpay error — surfaces the gateway error code so callers
 * can branch on specific failure modes (e.g. customer-not-found triggers
 * a stale-cache recovery in `SubscriptionMandateService`).
 */
export class RazorpayApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly httpStatus?: number,
  ) {
    super(`${code}: ${description}`);
    this.name = 'RazorpayApiError';
  }
}

/**
 * Razorpay client wrapper using PLATFORM-LEVEL credentials (env-driven).
 *
 * Distinct from the per-firm `RazorpayLinkService` (in
 * `modules/finance/sales/payment-link/`), which loads decrypted secrets
 * from individual `Firm` records to charge that firm's customers via
 * party-portal payment links. This service handles SaaS subscription
 * billing for ManekHR's own legal entity — single set of platform
 * credentials sourced from `appConfig.razorpayPlatform`.
 */
@Injectable()
export class RazorpayPlatformService {
  private readonly logger = new Logger(RazorpayPlatformService.name);
  private client: Razorpay | null = null;

  constructor(private readonly configService: ConfigService) {
    const keyId = this.configService.get<string>('app.razorpayPlatform.keyId');
    const keySecret = this.configService.get<string>(
      'app.razorpayPlatform.keySecret',
    );
    const env = this.configService.get<string>('app.environment');

    if (!keyId || !keySecret) {
      const msg =
        'Razorpay platform credentials missing — subscription checkout disabled until RAZORPAY_PLATFORM_KEY_ID + RAZORPAY_PLATFORM_KEY_SECRET are set';
      if (env === 'production') {
        // Fail loud at boot in prod — checkout endpoint must work.
        throw new Error(msg);
      }
      this.logger.warn(msg);
      return;
    }

    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    this.logger.log('Razorpay platform client initialised');
  }

  getKeyId(): string {
    const keyId = this.configService.get<string>('app.razorpayPlatform.keyId');
    if (!keyId) {
      throw new ServiceUnavailableException(
        'Razorpay platform credentials are not configured',
      );
    }
    return keyId;
  }

  /**
   * Create a Razorpay order for an upcoming one-time payment. The returned
   * order id is what the client passes to the Razorpay checkout sheet.
   */
  async createOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    if (!Number.isInteger(args.amountPaise) || args.amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be a positive integer');
    }
    if (args.receipt.length > 40) {
      // Razorpay caps receipt at 40 chars; refuse rather than silently truncate.
      throw new BadRequestException('receipt exceeds 40-char Razorpay cap');
    }

    try {
      const order = await this.client.orders.create({
        amount: args.amountPaise,
        currency: 'INR',
        receipt: args.receipt,
        notes: args.notes ?? {},
        payment_capture: true,
      });
      return {
        id: order.id,
        amount: Number(order.amount),
        currency: order.currency,
        status: order.status,
      };
    } catch (err: any) {
      const code = err?.error?.code ?? err?.code ?? 'unknown';
      const desc = err?.error?.description ?? err?.message ?? '';
      this.logger.error(
        `Razorpay orders.create failed: code=${code} desc=${desc}`,
      );
      throw new ServiceUnavailableException(
        'Failed to create payment order. Please retry.',
      );
    }
  }

  /**
   * Verify the checkout-sheet signed payload. Razorpay signs
   * `${order_id}|${payment_id}` with HMAC-SHA256 using the platform's
   * `key_secret`. We compare against the supplied signature in
   * constant time to avoid timing attacks.
   */
  verifyCheckoutSignature(args: VerifyArgs): boolean {
    const keySecret = this.configService.get<string>(
      'app.razorpayPlatform.keySecret',
    );
    if (!keySecret) return false;

    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${args.orderId}|${args.paymentId}`)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(args.signature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Create a Razorpay Customer. D1c — one customer per local User cached
   * on `User.razorpayCustomerId`. Default `failExisting=false` (returns
   * existing customer if email/contact already registered) so orphans
   * from prior partial runs don't block re-creation.
   */
  async createCustomer(args: CreateCustomerArgs): Promise<CreateCustomerResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }

    try {
      const customer = await this.client.customers.create({
        name: args.name,
        email: args.email,
        contact: args.contact,
        gstin: args.gstin,
        notes: args.notes ?? {},
        fail_existing: args.failExisting === true ? 1 : 0,
      });
      return {
        id: customer.id,
        entity: customer.entity,
        email: customer.email,
        contact: typeof customer.contact === 'number' ? String(customer.contact) : customer.contact,
      };
    } catch (err: any) {
      throw this.toApiError('customers.create', err);
    }
  }

  /**
   * Create a Razorpay Plan mirroring a local Plan + cycle. Idempotency
   * is enforced by the caller (cache on `Plan.razorpayPlanId<Cycle>`)
   * — Razorpay itself does NOT dedup `plans.create` calls.
   */
  async createPlan(args: CreatePlanArgs): Promise<CreatePlanResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    if (!Number.isInteger(args.amountPaise) || args.amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be a positive integer');
    }

    try {
      const plan = await this.client.plans.create({
        period: args.period,
        interval: args.interval,
        item: {
          name: args.name,
          amount: args.amountPaise,
          currency: args.currency ?? 'INR',
          description: args.description,
        },
        notes: args.notes ?? {},
      });
      return {
        id: plan.id,
        entity: plan.entity,
        period: plan.period,
        interval: plan.interval,
      };
    } catch (err: any) {
      throw this.toApiError('plans.create', err);
    }
  }

  /**
   * Create a Razorpay Subscription (mandate). Returns the `short_url`
   * the user opens to authorise the eMandate / UPI / card debit flow.
   * Razorpay status will be 'created' until the user completes the auth
   * payment, then transitions to 'authenticated' → 'active'. Webhook
   * delivers `subscription.activated` once active.
   */
  async createSubscription(args: CreateSubscriptionArgs): Promise<CreateSubscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    if (!Number.isInteger(args.totalCount) || args.totalCount <= 0) {
      throw new BadRequestException('totalCount must be a positive integer');
    }

    try {
      const sub = await this.client.subscriptions.create({
        plan_id: args.planId,
        total_count: args.totalCount,
        customer_notify: args.customerNotify ?? 1,
        quantity: args.quantity ?? 1,
        notes: args.notes ?? {},
      });
      return {
        id: sub.id,
        status: sub.status,
        shortUrl: sub.short_url,
        customerId: sub.customer_id,
        currentStart: sub.current_start ?? null,
        currentEnd: sub.current_end ?? null,
        chargeAt: sub.charge_at,
        startAt: sub.start_at,
        endAt: sub.end_at,
        paidCount: sub.paid_count,
        remainingCount: sub.remaining_count,
      };
    } catch (err: any) {
      throw this.toApiError('subscriptions.create', err);
    }
  }

  /**
   * Schedule a plan change on an existing Razorpay subscription. Used
   * by the coupon engine (D1e) to revert a discounted-first-cycle
   * mandate back to the standard plan from cycle 2 onwards.
   *
   * `scheduleChangeAt='cycle_end'` defers the change so the customer
   * is charged the discounted price for the current cycle, then the
   * full price thereafter. Razorpay validates the new plan id matches
   * the subscription's billing period.
   */
  async updateSubscriptionPlan(args: {
    subscriptionId: string;
    newPlanId: string;
    scheduleChangeAt: 'now' | 'cycle_end';
  }): Promise<CreateSubscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    try {
      const sub = await this.client.subscriptions.update(args.subscriptionId, {
        plan_id: args.newPlanId,
        schedule_change_at: args.scheduleChangeAt,
      });
      return this.mapSubscription(sub);
    } catch (err: any) {
      throw this.toApiError('subscriptions.update', err);
    }
  }

  /**
   * Create a Razorpay Payment Link (D1i — admin-issued links).
   *
   * Used when admin negotiates a custom price with a customer and
   * issues a one-time-pay link. The link's `notes` carry the local
   * `subscriptionPaymentId` so the `payment_link.paid` webhook can
   * round-trip back to our row without a secondary lookup.
   *
   * Returns the `short_url` for the customer + the link's id (stored
   * on `SubscriptionPayment.gatewayPaymentLinkId` for cancellation).
   */
  async createPaymentLink(args: {
    amountPaise: number;
    description: string;
    customer: { name?: string; email?: string; contact?: string };
    referenceId?: string;
    expireBySeconds?: number;
    notes?: Record<string, string>;
    callbackUrl?: string;
    notifyEmail?: boolean;
    notifySms?: boolean;
  }): Promise<{
    id: string;
    shortUrl: string;
    status: string;
    amount: number;
  }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    if (!Number.isInteger(args.amountPaise) || args.amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be a positive integer');
    }
    try {
      const link = await this.client.paymentLink.create({
        amount: args.amountPaise,
        currency: 'INR',
        description: args.description.slice(0, 2048),
        customer: args.customer,
        reference_id: args.referenceId,
        expire_by: args.expireBySeconds,
        notes: args.notes ?? {},
        callback_url: args.callbackUrl,
        callback_method: args.callbackUrl ? 'get' : undefined,
        notify: {
          email: args.notifyEmail ?? true,
          sms: args.notifySms ?? true,
        },
        reminder_enable: true,
      });
      return {
        id: link.id,
        shortUrl: link.short_url,
        status: link.status,
        amount: Number(link.amount ?? 0),
      };
    } catch (err: any) {
      throw this.toApiError('paymentLink.create', err);
    }
  }

  /** Cancel a payment link (admin recall). */
  async cancelPaymentLink(linkId: string): Promise<{ id: string; status: string }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    try {
      const result = await this.client.paymentLink.cancel(linkId);
      return { id: result.id, status: result.status };
    } catch (err: any) {
      throw this.toApiError('paymentLink.cancel', err);
    }
  }

  /**
   * Issue a refund against a captured payment (D1h). `amountPaise`
   * optional — omit for a full refund. Razorpay rejects refunds against
   * non-captured payments + amounts exceeding the available balance, so
   * caller MUST pre-check the local SubscriptionPayment status + sum
   * of prior refunds.
   *
   * `speed='normal'` (3-5 working days, free) is the default. Use
   * `'optimum'` when the customer needs immediate-mode refund (extra
   * fees per Razorpay pricing — opt-in via admin override).
   */
  async createRefund(args: {
    paymentId: string;
    amountPaise?: number;
    speed?: 'normal' | 'optimum';
    notes?: Record<string, string>;
  }): Promise<{
    id: string;
    paymentId: string;
    amount: number;
    status: 'pending' | 'processed' | 'failed';
    createdAt: number;
  }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    if (
      args.amountPaise !== undefined &&
      (!Number.isInteger(args.amountPaise) || args.amountPaise <= 0)
    ) {
      throw new BadRequestException('amountPaise must be a positive integer');
    }
    try {
      const refund = await this.client.payments.refund(args.paymentId, {
        amount: args.amountPaise,
        speed: args.speed ?? 'normal',
        notes: args.notes ?? {},
      });
      return {
        id: refund.id,
        paymentId: refund.payment_id,
        amount: Number(refund.amount ?? 0),
        status: refund.status,
        createdAt: refund.created_at,
      };
    } catch (err: any) {
      throw this.toApiError('payments.refund', err);
    }
  }

  /**
   * Cancel a Razorpay subscription. `cancelAtCycleEnd=true` keeps the
   * user's access through the paid period — the recommended default for
   * self-serve cancel. Set false for admin-initiated immediate cancel.
   */
  async cancelSubscription(
    subscriptionId: string,
    cancelAtCycleEnd = true,
  ): Promise<CreateSubscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    try {
      const sub = await this.client.subscriptions.cancel(
        subscriptionId,
        cancelAtCycleEnd,
      );
      return this.mapSubscription(sub);
    } catch (err: any) {
      throw this.toApiError('subscriptions.cancel', err);
    }
  }

  /**
   * Pause a Razorpay subscription immediately (`pause_at: 'now'`).
   * Razorpay does not currently support deferred-pause via SDK.
   */
  async pauseSubscription(subscriptionId: string): Promise<CreateSubscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    try {
      const sub = await this.client.subscriptions.pause(subscriptionId, {
        pause_at: 'now',
      });
      return this.mapSubscription(sub);
    } catch (err: any) {
      throw this.toApiError('subscriptions.pause', err);
    }
  }

  /**
   * Fetch a Razorpay subscription by id. Used by the mandate service
   * reuse-window dedup path to recover the `short_url` for an existing
   * in-flight mandate without re-creating one.
   */
  async fetchSubscription(subscriptionId: string): Promise<CreateSubscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    try {
      const sub = await this.client.subscriptions.fetch(subscriptionId);
      return this.mapSubscription(sub);
    } catch (err: any) {
      throw this.toApiError('subscriptions.fetch', err);
    }
  }

  /** Resume a paused Razorpay subscription immediately. */
  async resumeSubscription(subscriptionId: string): Promise<CreateSubscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Razorpay platform client unavailable — credentials not configured',
      );
    }
    try {
      const sub = await this.client.subscriptions.resume(subscriptionId, {
        resume_at: 'now',
      });
      return this.mapSubscription(sub);
    } catch (err: any) {
      throw this.toApiError('subscriptions.resume', err);
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private mapSubscription(sub: any): CreateSubscriptionResult {
    return {
      id: sub.id,
      status: sub.status,
      shortUrl: sub.short_url,
      customerId: sub.customer_id,
      currentStart: sub.current_start ?? null,
      currentEnd: sub.current_end ?? null,
      chargeAt: sub.charge_at,
      startAt: sub.start_at,
      endAt: sub.end_at,
      paidCount: sub.paid_count,
      remainingCount: sub.remaining_count,
    };
  }

  /**
   * Normalise Razorpay SDK errors into a structured form callers can
   * branch on. Logs at error level — the SDK already strips secrets
   * from its error payloads, so logging the description is safe.
   */
  private toApiError(op: string, err: any): RazorpayApiError {
    const code = err?.error?.code ?? err?.code ?? 'unknown';
    const desc = err?.error?.description ?? err?.message ?? 'Razorpay API call failed';
    const status = err?.statusCode ?? err?.error?.statusCode;
    this.logger.error(`Razorpay ${op} failed: code=${code} desc=${desc}`);
    return new RazorpayApiError(String(code), String(desc), status);
  }

  /**
   * Verify a Razorpay webhook delivery. Razorpay HMAC-SHA256 signs the
   * EXACT raw request body using the dashboard-configured webhook secret
   * (separate from `key_secret`). The signature is sent as
   * `X-Razorpay-Signature`. Constant-time compare to avoid leaking any
   * byte-by-byte timing data.
   *
   * Returns false on any failure (missing secret, malformed signature,
   * length mismatch). Caller MUST treat false as a 401 — never reveal
   * which condition failed.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const webhookSecret = this.configService.get<string>(
      'app.razorpayPlatform.webhookSecret',
    );
    if (!webhookSecret || !signature || !rawBody) return false;

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
