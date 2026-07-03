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
import { Plan } from '../../schemas/plan.schema';
import { Subscription } from '../../schemas/subscription.schema';
import { SubscriptionsService } from '../../subscriptions.service';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { User } from '../../../users/schemas/user.schema';
import { PricingService } from './pricing.service';
import { RazorpayPlatformService } from './razorpay-platform.service';
import { CouponService } from './coupon.service';
import { InvoiceService } from './invoice.service';
import { AuditAction, AuditLogService } from './audit-log.service';
import { CreateCheckoutDto, ConfirmPaymentDto } from '../dto/checkout.dto';
import { BillingCycle, DiscountResolution } from '../billing.types';

interface CreateOrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  planId: string;
  billingCycle: BillingCycle;
  /** Mongo id of the SubscriptionPayment row — round-trip back on /confirm. */
  paymentId: string;
}

interface ConfirmPaymentResponse {
  subscriptionId: string;
  paymentId: string;
  totalPaise: number;
  capturedAt: Date;
}

@Injectable()
export class SubscriptionCheckoutService {
  private readonly logger = new Logger(SubscriptionCheckoutService.name);

  /**
   * How long an open (status=created) SubscriptionPayment is treated as
   * still re-usable by a duplicate createOrder call from the same user.
   * Razorpay orders themselves stay valid much longer, but 10 min is the
   * outer bound for a user actually keeping the checkout sheet open — past
   * that we assume they walked away and a fresh order is safer.
   */
  private static readonly OPEN_ORDER_REUSE_WINDOW_MS = 10 * 60 * 1000;

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptionsService: SubscriptionsService,
    private readonly pricing: PricingService,
    private readonly razorpay: RazorpayPlatformService,
    private readonly coupons: CouponService,
    private readonly invoices: InvoiceService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Step 1 — user picked a plan; create a Razorpay order and persist a
   * `SubscriptionPayment` row in `created` state. The returned payload
   * powers the Razorpay client-side checkout sheet.
   *
   * Duplicate-call defence: if an open (status=created) payment row exists
   * for the same (userId, planId, billingCycle, totalPaise) inside the
   * reuse window, reuse it instead of creating another Razorpay order.
   * This is the third defensive layer — throttler + Idempotency-Key are
   * the first two — and protects us when a buggy client re-renders the
   * checkout button and fires order-create in a loop without an
   * Idempotency-Key header.
   */
  async createOrder(
    userId: string,
    dto: CreateCheckoutDto,
  ): Promise<CreateOrderResponse> {
    const plan = await this.planModel.findById(dto.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');

    await this.assertPlanEligibleForUser(plan, userId);

    if (!plan.supportsOneTime) {
      throw new BadRequestException(
        'This plan is sold through auto-renew only. Contact sales if you need a one-time charge.',
      );
    }

    // Defer to SubscriptionsService for the same conflict checks the
    // existing /subscribe endpoint runs internally — fail fast before
    // creating a Razorpay order the user can't redeem.
    await this.subscriptionsService.assertCanSubscribeTo(userId, plan);

    // Compute the base quote first (no coupon) so coupon math knows
    // what list-price to discount against.
    const baseQuote = this.pricing.computeQuote(plan, dto.billingCycle);

    // Resolve coupons (if any). User-supplied codes take precedence
    // over auto-apply; an empty `couponCodes` array with a campaign
    // key triggers the auto-apply scan.
    const couponResolution = await this.resolveCheckoutCoupons({
      userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      basePricePaise: baseQuote.basePricePaise,
      codes: dto.couponCodes,
      campaignKey: dto.autoApplyCampaignKey,
    });

    const quote = this.pricing.computeQuote(plan, dto.billingCycle, {
      discountOnBasePaise: couponResolution.discountOnBasePaise,
      finalTotalOverridePaise: couponResolution.finalTotalOverridePaise,
      appliedCouponCode: couponResolution.resolved.map((r) => r.code).join(',') || undefined,
      appliedCouponId: couponResolution.resolved[0]?.couponId,
    });

    // Reuse an open order if the same user already has one in flight for
    // the same plan + cycle + price. Price match guards against a price
    // change between the two calls (e.g. coupon applied on the second).
    const reusable = await this.findReusableOpenPayment({
      userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      totalPaise: quote.totalPaise,
    });
    if (reusable) {
      this.logger.log(
        `Checkout order reused user=${userId} plan=${dto.planId} cycle=${dto.billingCycle} order=${reusable.gatewayOrderId} payment=${reusable._id}`,
      );
      return {
        orderId: reusable.gatewayOrderId!,
        amount: reusable.totalPaise,
        currency: 'INR',
        keyId: this.razorpay.getKeyId(),
        planId: dto.planId,
        billingCycle: dto.billingCycle,
        paymentId: String(reusable._id),
      };
    }

    const order = await this.razorpay.createOrder({
      amountPaise: quote.totalPaise,
      receipt: this.buildReceipt(userId),
      notes: {
        userId,
        planId: dto.planId,
        billingCycle: dto.billingCycle,
        ...(couponResolution.resolved.length
          ? { coupons: couponResolution.resolved.map((r) => r.code).join(',') }
          : {}),
      },
    });

    // Snapshot billing profile from User onto the payment row so the
    // invoice generator (D1f) is reproducible without re-reading User.
    const userForSnapshot = await this.userModel
      .findById(userId)
      .select('name email mobile billingProfile')
      .exec();
    const billingSnapshot = userForSnapshot
      ? InvoiceService.buildBillingSnapshot(userForSnapshot.toObject())
      : undefined;

    const payment = await this.paymentModel.create({
      userId: new Types.ObjectId(userId),
      planId: new Types.ObjectId(dto.planId),
      billingCycle: dto.billingCycle,
      paymentMode: 'one_time',
      status: 'created',
      gateway: 'razorpay',
      gatewayOrderId: order.id,
      planPricePaise: quote.basePricePaise,
      discountPaise: quote.discountPaise,
      gstPaise: quote.gstPaise,
      totalPaise: quote.totalPaise,
      gstRatePercent: quote.gstRatePercent,
      ...(billingSnapshot ? { billingSnapshot } : {}),
      // Snapshot first applied coupon for the existing schema field;
      // the full resolution list is replayed via the resolve call at
      // confirm time (codes carried in the order notes for auditing).
      ...(couponResolution.resolved[0]
        ? {
            appliedCouponId: new Types.ObjectId(
              couponResolution.resolved[0].couponId,
            ),
            appliedCouponCode: couponResolution.resolved[0].code,
          }
        : {}),
    });

    this.logger.log(
      `Checkout order created user=${userId} plan=${dto.planId} cycle=${dto.billingCycle} order=${order.id}`,
    );
    await this.audit.log({
      action: AuditAction.SelfCheckoutOrderCreated,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      paymentId: String(payment._id),
      planId: dto.planId,
      metadata: {
        gatewayOrderId: order.id,
        billingCycle: dto.billingCycle,
        totalPaise: quote.totalPaise,
        couponCodes: dto.couponCodes,
      },
    });

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: this.razorpay.getKeyId(),
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      paymentId: String(payment._id),
    };
  }

  /**
   * Find an in-flight, still-valid SubscriptionPayment that can serve a
   * duplicate createOrder call without burning a fresh Razorpay order.
   */
  private async findReusableOpenPayment(args: {
    userId: string;
    planId: string;
    billingCycle: BillingCycle;
    totalPaise: number;
  }): Promise<SubscriptionPayment | null> {
    const cutoff = new Date(
      Date.now() - SubscriptionCheckoutService.OPEN_ORDER_REUSE_WINDOW_MS,
    );
    return this.paymentModel
      .findOne({
        userId: new Types.ObjectId(args.userId),
        planId: new Types.ObjectId(args.planId),
        billingCycle: args.billingCycle,
        status: 'created',
        gateway: 'razorpay',
        totalPaise: args.totalPaise,
        gatewayOrderId: { $exists: true, $ne: null },
        createdAt: { $gte: cutoff },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Step 2 — Razorpay sheet returned a signed payload. Verify the
   * signature, transition the SubscriptionPayment to `captured`, then
   * delegate to existing `subscribe()` to create the Subscription row.
   *
   * Idempotent: re-issuing the same confirm with the same payment id
   * resolves to the existing captured row instead of double-writing.
   */
  async confirmPayment(
    userId: string,
    dto: ConfirmPaymentDto,
  ): Promise<ConfirmPaymentResponse> {
    const payment = await this.paymentModel
      .findById(dto.subscriptionPaymentId)
      .exec();
    if (!payment) {
      throw new NotFoundException('Payment record not found');
    }
    if (String(payment.userId) !== userId) {
      throw new ForbiddenException('Payment record does not belong to user');
    }
    if (payment.gatewayOrderId !== dto.razorpayOrderId) {
      throw new BadRequestException('Razorpay order id mismatch');
    }

    // Idempotent path — already captured. Return the existing snapshot.
    if (payment.status === 'captured' && payment.subscriptionId) {
      return this.toConfirmResponse(payment);
    }
    if (payment.status !== 'created') {
      throw new BadRequestException(
        `Payment is in non-confirmable state: ${payment.status}`,
      );
    }

    const verified = this.razorpay.verifyCheckoutSignature({
      orderId: dto.razorpayOrderId,
      paymentId: dto.razorpayPaymentId,
      signature: dto.razorpaySignature,
    });
    if (!verified) {
      throw new BadRequestException('Razorpay signature verification failed');
    }

    // Atomic transition. If another request beat us to it, re-read and
    // return idempotently.
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
        return this.toConfirmResponse(reread);
      }
      throw new BadRequestException('Payment is not in a confirmable state');
    }

    // Delegate to existing subscribe() to enact tier transitions /
    // supersede previous active subs.
    const subscription = await this.subscriptionsService.subscribe(userId, {
      planId: String(payment.planId),
      billingCycle: payment.billingCycle,
      activateImmediately: true,
    });

    // Stamp Razorpay handles + source onto the subscription, plus link the
    // payment row back to the subscription.
    await this.subscriptionModel
      .findByIdAndUpdate(subscription._id, {
        $set: {
          razorpayOrderId: dto.razorpayOrderId,
          razorpayPaymentId: dto.razorpayPaymentId,
          source: 'self',
        },
      })
      .exec();

    captured.subscriptionId = subscription._id as Types.ObjectId;
    await captured.save();

    // Record coupon redemption(s) at capture time. We re-resolve from
    // the snapshot stored on the payment row so multi-coupon stacks
    // are recorded with their correct discount distribution.
    if (captured.appliedCouponCode) {
      try {
        const codes = captured.appliedCouponCode.split(',').filter(Boolean);
        const replay = await this.coupons.resolveCodes({
          codes,
          userId,
          planId: String(captured.planId),
          billingCycle: captured.billingCycle as 'monthly' | 'yearly',
          basePricePaise: captured.planPricePaise,
        });
        await this.coupons.recordRedemptions({
          payment: captured,
          resolved: replay.resolved,
          userId,
        });
      } catch (err) {
        // Capture is already done — never fail the user-facing
        // confirm because of a redemption-recording issue. Surface
        // for ops via log; admin can replay via the raw event log.
        this.logger.warn(
          `Coupon redemption record failed payment=${captured._id} err=${(err as Error).message}`,
        );
      }
    }

    // Generate the GST invoice (D1f). Async — never fail the
    // user-facing confirm because of a PDF/storage hiccup; the
    // download endpoint is the recovery path.
    this.invoices
      .generate(String(captured._id))
      .catch((err) =>
        this.logger.warn(
          `Invoice generation failed payment=${captured._id} err=${(err as Error).message}`,
        ),
      );

    await this.audit.log({
      action: AuditAction.SelfCheckoutConfirmed,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      paymentId: String(captured._id),
      subscriptionId: String(subscription._id),
      planId: String(captured.planId),
      metadata: {
        gatewayPaymentId: dto.razorpayPaymentId,
        totalPaise: captured.totalPaise,
      },
    });

    this.logger.log(
      `Checkout confirmed user=${userId} payment=${captured._id} sub=${subscription._id}`,
    );

    return this.toConfirmResponse(captured);
  }

  // ── coupon resolution helper ────────────────────────────────────────

  /**
   * Resolve coupons for a checkout. Customer codes win over auto-apply.
   * Returns an empty resolution if neither codes nor a campaign key
   * are supplied.
   */
  private async resolveCheckoutCoupons(args: {
    userId: string;
    planId: string;
    billingCycle: 'monthly' | 'yearly';
    basePricePaise: number;
    codes?: string[];
    campaignKey?: string;
  }): Promise<DiscountResolution> {
    if (args.codes && args.codes.length > 0) {
      return this.coupons.resolveCodes({
        codes: args.codes,
        userId: args.userId,
        planId: args.planId,
        billingCycle: args.billingCycle,
        basePricePaise: args.basePricePaise,
      });
    }
    if (args.campaignKey) {
      return this.coupons.resolveAutoApply({
        userId: args.userId,
        planId: args.planId,
        billingCycle: args.billingCycle,
        basePricePaise: args.basePricePaise,
        campaignKey: args.campaignKey,
      });
    }
    return {
      resolved: [],
      totalDiscountPaise: 0,
      warnings: [],
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * Build a Razorpay-receipt string under their 40-char cap.
   * Format: `s-<userId12>-<base36ts>` (max 4 + 12 + 1 + ~9 = 26 chars).
   */
  private buildReceipt(userId: string): string {
    const userTail = userId.slice(-12);
    const tsB36 = Date.now().toString(36);
    return `s-${userTail}-${tsB36}`;
  }

  /**
   * Custom plans are restricted to their assigned user/workspace. Catalogue
   * plans (`isCustom=false`) are open to anyone, even when they have
   * `isPubliclyVisible=false` — the visibility flag governs the public
   * pricing page only, not direct checkout access for users who already
   * have the plan id.
   */
  private async assertPlanEligibleForUser(
    plan: Plan,
    userId: string,
  ): Promise<void> {
    if (!plan.isCustom) return;

    const userObjectId = new Types.ObjectId(userId);
    if (
      plan.assignedUserId &&
      plan.assignedUserId.toString() === userObjectId.toString()
    ) {
      return;
    }

    // Workspace-scoped custom plan — caller must own the workspace. To avoid
    // a circular import on WorkspacesModule, resolve via a Mongo lookup
    // against the workspace member collection at request time. Cheap query,
    // small membership rows.
    if (plan.assignedWorkspaceId) {
      const memberRow = await this.subscriptionModel.db
        .collection('workspacemembers')
        .findOne({
          workspaceId: plan.assignedWorkspaceId,
          userId: userObjectId,
          status: 'active',
          // Only the workspace owner / admin can subscribe on behalf of the
          // workspace. Treat anything else as ineligible to avoid misuse.
          role: { $in: ['owner', 'admin'] },
        });
      if (memberRow) return;
    }

    throw new ForbiddenException(
      'This custom plan is not available for your account',
    );
  }

  private toConfirmResponse(
    payment: SubscriptionPayment,
  ): ConfirmPaymentResponse {
    return {
      subscriptionId: payment.subscriptionId
        ? String(payment.subscriptionId)
        : '',
      paymentId: String(payment._id),
      totalPaise: payment.totalPaise,
      capturedAt: payment.capturedAt ?? new Date(),
    };
  }
}
