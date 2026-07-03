import {
  BadRequestException,
  ConflictException,
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
import { User } from '../../../users/schemas/user.schema';
import { SubscriptionsService } from '../../subscriptions.service';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { PricingService } from './pricing.service';
import { RazorpayApiError, RazorpayPlatformService } from './razorpay-platform.service';
import { CouponService } from './coupon.service';
import { InvoiceService } from './invoice.service';
import { AuditAction, AuditLogService } from './audit-log.service';
import { CancelMandateDto, CreateMandateDto, PauseMandateDto } from '../dto/mandate.dto';
import { BillingCycle, DiscountResolution } from '../billing.types';

interface CreateMandateResponse {
  /** Razorpay-hosted authorization URL — open in browser to start eMandate / UPI / card auth. */
  shortUrl: string;
  razorpaySubscriptionId: string;
  /** Mongo id of the local Subscription row created in `pending` state. */
  subscriptionId: string;
  /** Mongo id of the SubscriptionPayment row that will be linked to the first charge. */
  paymentId: string;
  /** Echo of the Razorpay key id so the client can also drive an embedded Razorpay flow if it prefers. */
  keyId: string;
  /** Human-readable summary of what will be debited every cycle (paise). */
  amountPaise: number;
  totalCount: number;
}

interface MandateActionResponse {
  subscriptionId: string;
  status: string;
  razorpaySubscriptionId: string;
}

/**
 * SaaS recurring billing via Razorpay Subscriptions API (D1c).
 *
 * Flow:
 *   1. `createMandate(userId, dto)`:
 *      - validate plan + UPI/eMandate prereqs (email + mobile present)
 *      - 10-min reuse-window dedup against open `pending` mandate for same plan
 *      - lazy-ensure Razorpay Customer (cached on `User.razorpayCustomerId`,
 *        with stale-customer recovery on first failure)
 *      - lazy-ensure Razorpay Plan mirror (cached on
 *        `Plan.razorpayPlanIdMonthly/Yearly`, race-safe via atomic
 *        `findOneAndUpdate` with `$exists:false` guard)
 *      - call `subscriptions.create` → returns `short_url`
 *      - persist a `pending` Subscription + a `recurring/created`
 *        SubscriptionPayment row stamped with `gatewaySubscriptionId`
 *      - DO NOT supersede the user's existing active subscription yet —
 *        wait for `subscription.activated` webhook (auth payment may
 *        fail, in which case the user must keep their existing access).
 *   2. `cancelMandate / pauseMandate / resumeMandate`:
 *      - locate the user's mandate-bound Subscription
 *      - call Razorpay
 *      - rely on `subscription.cancelled / paused / resumed` webhooks
 *        to update local state (idempotent transitions in webhook
 *        service). This call only kicks the gateway — local row stays
 *        in flight until the webhook arrives.
 *
 * Defence stack at controller layer (mirrors D1b):
 *   - JwtAuthGuard pins userId per-request (per-user throttler key).
 *   - ThrottlerGuard `billing-create` (5/60s) on createMandate;
 *     `billing-mutate` (10/60s) on cancel/pause/resume.
 *   - `@Idempotent()` honours optional `Idempotency-Key` header.
 *   - Service-level reuse-window dedup is the third layer (catches
 *     clients that don't send `Idempotency-Key`).
 *
 * Locked decisions per `feedback_build_philosophy.md` + session 2026-05-04:
 *   - INR only.
 *   - GST handling: Razorpay-side plan price = GST-inclusive total.
 *   - `total_count` defaults: monthly=120, yearly=50; per-Plan override
 *     fields available.
 *   - One Razorpay Customer per local User, cached on `User`.
 *   - Lazy plan mirror; orphan Razorpay plans accepted (free).
 */
@Injectable()
export class SubscriptionMandateService {
  private readonly logger = new Logger(SubscriptionMandateService.name);

  /** 10-minute window for reusing an in-flight pending mandate. */
  private static readonly OPEN_MANDATE_REUSE_WINDOW_MS = 10 * 60 * 1000;

  /** Default Razorpay total_count per cycle when Plan does not override. */
  private static readonly DEFAULT_TOTAL_COUNT_MONTHLY = 120;
  private static readonly DEFAULT_TOTAL_COUNT_YEARLY = 50;

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
    private readonly audit: AuditLogService,
  ) {}

  // ── public API ──────────────────────────────────────────────────────

  async createMandate(userId: string, dto: CreateMandateDto): Promise<CreateMandateResponse> {
    const plan = await this.planModel.findById(dto.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isActive) {
      throw new BadRequestException('Plan is not active');
    }
    if (!plan.supportsAutoRenew) {
      throw new BadRequestException(
        'This plan is not available for auto-renew. Use one-time checkout instead.',
      );
    }

    await this.assertPlanEligibleForUser(plan, userId);

    // Defer to existing /subscribe gating (active sub conflict, custom
    // plan ownership, etc.) so a user who can't activate this plan
    // never gets a Razorpay mandate they can't redeem.
    await this.subscriptionsService.assertCanSubscribeTo(userId, plan);

    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    this.assertMandatePrereqsForUser(user);

    // Compute the no-coupon base quote so coupon math knows what
    // list-price to discount against.
    const baseQuote = this.pricing.computeQuote(plan, dto.billingCycle);

    // Resolve coupons (if any). For mandate flows the discount applies
    // to the FIRST CYCLE ONLY — see the discounted-plan + scheduled-
    // revert logic below.
    const couponResolution = await this.resolveMandateCoupons({
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

    const totalCount = this.resolveTotalCount(plan, dto);

    // Reuse-window dedup — if user already has an open pending mandate
    // for the same plan/cycle/total, return the existing short_url
    // instead of creating a second Razorpay subscription.
    const reusable = await this.findReusableOpenMandate({
      userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      totalPaise: quote.totalPaise,
    });
    if (reusable) {
      const reusableSub = await this.subscriptionModel.findById(reusable.subscriptionId).exec();
      if (reusableSub?.razorpaySubscriptionId) {
        try {
          const fetched = await this.razorpay.fetchSubscription(reusableSub.razorpaySubscriptionId);
          this.logger.log(
            `Mandate reused user=${userId} plan=${dto.planId} cycle=${dto.billingCycle} sub=${String(reusableSub._id)} rzp=${reusableSub.razorpaySubscriptionId}`,
          );
          return {
            shortUrl: fetched.shortUrl,
            razorpaySubscriptionId: reusableSub.razorpaySubscriptionId,
            subscriptionId: String(reusableSub._id),
            paymentId: String(reusable._id),
            keyId: this.razorpay.getKeyId(),
            amountPaise: quote.totalPaise,
            totalCount,
          };
        } catch (err) {
          // Razorpay-side gone (rare — mandate auto-expired). Fall
          // through to fresh creation. Mark the stale row failed so
          // we don't keep matching it.
          this.logger.warn(
            `Reuse fetch failed for rzp sub ${reusableSub.razorpaySubscriptionId} — falling through. err=${(err as Error).message}`,
          );
          await this.paymentModel
            .updateOne(
              { _id: reusable._id, status: 'created' },
              {
                $set: {
                  status: 'failed',
                  failureReason: 'mandate_short_url_unreachable',
                  failedAt: new Date(),
                },
              },
            )
            .exec();
          await this.subscriptionModel
            .updateOne({ _id: reusableSub._id, status: 'pending' }, { $set: { status: 'expired' } })
            .exec();
        }
      }
    }

    // Lazy ensure customer + standard plan (always need it: either as
    // the subscription's plan_id directly, or as the revert target
    // when a coupon is applied).
    const razorpayCustomerId = await this.ensureRazorpayCustomer(user);
    const standardRazorpayPlanId = await this.ensureRazorpayPlan(
      plan,
      dto.billingCycle,
      baseQuote.totalPaise,
    );

    // When a coupon discount applies, lazy-create a one-shot
    // discounted Razorpay Plan (no caching — coupon stacks vary per
    // checkout) and bind the mandate to it; the scheduled-revert
    // below switches future cycles back to the standard plan.
    const subscriptionPlanId =
      couponResolution.totalDiscountPaise > 0
        ? await this.createDiscountedRazorpayPlan(
            plan,
            dto.billingCycle,
            quote.totalPaise,
            couponResolution.resolved.map((r) => r.code).join(','),
          )
        : standardRazorpayPlanId;

    // Create Razorpay subscription. Stale-customer recovery: if the
    // cached customer was deleted in the dashboard, retry once with a
    // fresh customer.
    const subscriptionNotes: Record<string, string> = {
      localUserId: userId,
      localPlanId: dto.planId,
      billingCycle: dto.billingCycle,
    };
    if (couponResolution.resolved.length) {
      subscriptionNotes.coupons = couponResolution.resolved.map((r) => r.code).join(',');
    }

    let rzpSub;
    try {
      rzpSub = await this.razorpay.createSubscription({
        planId: subscriptionPlanId,
        totalCount,
        customerNotify: 1,
        notes: subscriptionNotes,
      });
    } catch (err) {
      if (this.isStaleCustomerError(err)) {
        this.logger.warn(
          `Razorpay customer ${razorpayCustomerId} stale — recovering for user=${userId}`,
        );
        await this.userModel
          .updateOne({ _id: userId, razorpayCustomerId }, { $unset: { razorpayCustomerId: '' } })
          .exec();
        const freshUser = await this.userModel.findById(userId).exec();
        if (!freshUser) throw new NotFoundException('User not found');
        await this.ensureRazorpayCustomer(freshUser);
        rzpSub = await this.razorpay.createSubscription({
          planId: subscriptionPlanId,
          totalCount,
          customerNotify: 1,
          notes: { ...subscriptionNotes, recovery: 'stale_customer' },
        });
      } else {
        throw err;
      }
    }

    // Schedule the post-discount revert to the standard plan from
    // cycle 2 onwards. If this call fails we log and continue — the
    // subscription is created and the user can pay; admin can replay
    // the schedule via the failed-event log. Failing the whole
    // mandate now would be worse UX (user re-tries, hits Razorpay
    // again, more orphans).
    if (subscriptionPlanId !== standardRazorpayPlanId) {
      try {
        await this.razorpay.updateSubscriptionPlan({
          subscriptionId: rzpSub.id,
          newPlanId: standardRazorpayPlanId,
          scheduleChangeAt: 'cycle_end',
        });
      } catch (err) {
        this.logger.error(
          `Failed to schedule plan revert for sub=${rzpSub.id} — manual reconciliation needed. err=${(err as Error).message}`,
        );
      }
    }

    // Persist local Subscription + SubscriptionPayment in `pending` /
    // `created`. Subscription supersession of the user's existing
    // active sub is deferred to webhook activation — if the auth
    // payment fails the user must retain access.
    const localSub = await this.persistPendingSubscription({
      userId,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      razorpaySubscriptionId: rzpSub.id,
      plan,
    });

    const billingSnapshot = InvoiceService.buildBillingSnapshot(user.toObject());

    const payment = await this.paymentModel.create({
      userId: new Types.ObjectId(userId),
      subscriptionId: localSub._id,
      planId: new Types.ObjectId(dto.planId),
      billingCycle: dto.billingCycle,
      paymentMode: 'recurring',
      status: 'created',
      gateway: 'razorpay',
      gatewaySubscriptionId: rzpSub.id,
      planPricePaise: quote.basePricePaise,
      discountPaise: quote.discountPaise,
      gstPaise: quote.gstPaise,
      totalPaise: quote.totalPaise,
      gstRatePercent: quote.gstRatePercent,
      billingSnapshot,
      ...(couponResolution.resolved[0]
        ? {
            appliedCouponId: new Types.ObjectId(couponResolution.resolved[0].couponId),
            appliedCouponCode: couponResolution.resolved.map((r) => r.code).join(','),
          }
        : {}),
    });

    this.logger.log(
      `Mandate created user=${userId} plan=${dto.planId} cycle=${dto.billingCycle} rzp=${rzpSub.id} sub=${String(localSub._id)}`,
    );
    await this.audit.log({
      action: AuditAction.SelfMandateCreated,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(localSub._id),
      paymentId: String(payment._id),
      planId: dto.planId,
      metadata: {
        razorpaySubscriptionId: rzpSub.id,
        billingCycle: dto.billingCycle,
        totalCount,
        amountPaise: quote.totalPaise,
        couponCodes: dto.couponCodes,
      },
    });

    return {
      shortUrl: rzpSub.shortUrl,
      razorpaySubscriptionId: rzpSub.id,
      subscriptionId: String(localSub._id),
      paymentId: String(payment._id),
      keyId: this.razorpay.getKeyId(),
      amountPaise: quote.totalPaise,
      totalCount,
    };
  }

  async cancelMandate(userId: string, dto: CancelMandateDto): Promise<MandateActionResponse> {
    const sub = await this.findUserMandate(userId);
    const cancelAtCycleEnd = dto.cancelAtCycleEnd ?? true;
    await this.razorpay.cancelSubscription(sub.razorpaySubscriptionId, cancelAtCycleEnd);
    // Local state stays as-is until subscription.cancelled webhook
    // arrives. Stamp the cancellation reason now so admin/audit can
    // see who initiated it without waiting for the webhook.
    await this.subscriptionModel
      .updateOne(
        { _id: sub._id },
        {
          $set: {
            cancellationReason: cancelAtCycleEnd
              ? 'self_cancel_at_cycle_end'
              : 'self_cancel_immediate',
          },
        },
      )
      .exec();
    this.logger.log(
      `Mandate cancel queued user=${userId} sub=${String(sub._id)} rzp=${sub.razorpaySubscriptionId} atCycleEnd=${cancelAtCycleEnd}`,
    );
    await this.audit.log({
      action: AuditAction.SelfMandateCancelled,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(sub._id),
      metadata: {
        razorpaySubscriptionId: sub.razorpaySubscriptionId,
        cancelAtCycleEnd,
      },
    });
    return this.toActionResponse(sub);
  }

  async pauseMandate(userId: string, dto: PauseMandateDto): Promise<MandateActionResponse> {
    const sub = await this.findUserMandate(userId);
    if (sub.status === 'paused') {
      throw new ConflictException('Mandate is already paused');
    }
    await this.razorpay.pauseSubscription(sub.razorpaySubscriptionId);
    await this.subscriptionModel
      .updateOne(
        { _id: sub._id },
        {
          $set: {
            pauseReason: dto.reason ?? 'self_pause',
          },
        },
      )
      .exec();
    this.logger.log(
      `Mandate pause queued user=${userId} sub=${String(sub._id)} rzp=${sub.razorpaySubscriptionId}`,
    );
    await this.audit.log({
      action: AuditAction.SelfMandatePaused,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(sub._id),
      metadata: { reason: dto.reason },
    });
    return this.toActionResponse(sub);
  }

  async resumeMandate(userId: string): Promise<MandateActionResponse> {
    const sub = await this.findUserMandate(userId, {
      includePaused: true,
    });
    if (sub.status !== 'paused') {
      throw new ConflictException(`Mandate is not paused (current status: ${sub.status})`);
    }
    await this.razorpay.resumeSubscription(sub.razorpaySubscriptionId);
    this.logger.log(
      `Mandate resume queued user=${userId} sub=${String(sub._id)} rzp=${sub.razorpaySubscriptionId}`,
    );
    await this.audit.log({
      action: AuditAction.SelfMandateResumed,
      actorType: 'self',
      actorUserId: userId,
      targetUserId: userId,
      subscriptionId: String(sub._id),
    });
    return this.toActionResponse(sub);
  }

  // ── lazy customer ───────────────────────────────────────────────────

  /**
   * Lazy-ensure a Razorpay Customer exists for this User. Cache key is
   * `User.razorpayCustomerId`. Uses `failExisting=false` so a duplicate
   * (email/contact) returns the existing customer instead of erroring —
   * defends against orphans from prior partial runs.
   */
  private async ensureRazorpayCustomer(user: User): Promise<string> {
    if (user.razorpayCustomerId) return user.razorpayCustomerId;

    const created = await this.razorpay.createCustomer({
      name: user.name,
      email: user.email,
      contact: user.mobile,
      failExisting: false,
      notes: { localUserId: String(user._id) },
    });

    // Atomic cache write — only set if still empty. If a parallel call
    // already cached a (potentially different) customer id, that one
    // wins and we discard ours; Razorpay deduped both creates against
    // the same (email, contact) pair so the customer id likely matches
    // anyway. Discrepancies log a warning for admin investigation.
    const updated = await this.userModel
      .findOneAndUpdate(
        { _id: user._id, razorpayCustomerId: { $exists: false } },
        { $set: { razorpayCustomerId: created.id } },
        { new: false },
      )
      .exec();
    if (updated?.razorpayCustomerId && updated.razorpayCustomerId !== created.id) {
      this.logger.warn(
        `Razorpay customer race for user=${String(user._id)}: kept ${updated.razorpayCustomerId}, discarded ${created.id}`,
      );
      return updated.razorpayCustomerId;
    }
    return created.id;
  }

  // ── lazy plan mirror ────────────────────────────────────────────────

  /**
   * Lazy-ensure a Razorpay Plan mirror exists for this (Plan, cycle).
   * Caches the Razorpay plan id on `Plan.razorpayPlanId<Cycle>`.
   * Race-safe via atomic `findOneAndUpdate` with `$exists:false` guard
   * — if a parallel call beats us, we discard the just-minted plan
   * (orphan accepted; Razorpay plans cost nothing).
   */
  private async ensureRazorpayPlan(
    plan: Plan,
    cycle: 'monthly' | 'yearly',
    amountInclusivePaise: number,
  ): Promise<string> {
    const cacheField = cycle === 'monthly' ? 'razorpayPlanIdMonthly' : 'razorpayPlanIdYearly';
    const existing = (plan as any)[cacheField];
    if (existing) return existing;

    // Re-read once in case another request just cached it.
    const fresh = await this.planModel.findById(plan._id).select(`${cacheField}`).exec();
    const refreshed = fresh ? (fresh as any)[cacheField] : null;
    if (refreshed) return refreshed;

    const created = await this.razorpay.createPlan({
      amountPaise: amountInclusivePaise,
      currency: 'INR',
      name: `${plan.name} (${cycle})`,
      description: `ManekHR plan ${plan.name} ${cycle} mandate`,
      period: cycle,
      interval: 1,
      notes: {
        localPlanId: String(plan._id),
        cycle,
      },
    });

    // Atomic claim — only set if still empty.
    const updated = await this.planModel
      .findOneAndUpdate(
        { _id: plan._id, [cacheField]: { $exists: false } },
        { $set: { [cacheField]: created.id } },
        { new: false },
      )
      .exec();

    const winner = updated ? (updated as any)[cacheField] : null;
    if (winner) {
      // Lost race; orphan our just-created Razorpay plan id.
      this.logger.warn(
        `Razorpay plan mirror race for plan=${String(plan._id)} cycle=${cycle}: kept ${winner}, orphaned ${created.id}`,
      );
      return winner;
    }
    return created.id;
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private resolveTotalCount(plan: Plan, dto: CreateMandateDto): number {
    if (dto.totalCount) return dto.totalCount;
    if (dto.billingCycle === 'monthly') {
      return (
        plan.recurringTotalCountMonthly ?? SubscriptionMandateService.DEFAULT_TOTAL_COUNT_MONTHLY
      );
    }
    return plan.recurringTotalCountYearly ?? SubscriptionMandateService.DEFAULT_TOTAL_COUNT_YEARLY;
  }

  private assertMandatePrereqsForUser(user: User): void {
    if (!user.email && !user.mobile) {
      throw new BadRequestException(
        'Email and mobile are required for auto-renew. Please add them in your profile before subscribing.',
      );
    }
    if (!user.email) {
      throw new BadRequestException(
        'Email is required for auto-renew. Please add an email to your profile.',
      );
    }
    if (!user.mobile) {
      throw new BadRequestException(
        'Mobile number is required for auto-renew. Please add one to your profile.',
      );
    }
  }

  private async assertPlanEligibleForUser(plan: Plan, userId: string): Promise<void> {
    if (!plan.isCustom) return;
    const userObjectId = new Types.ObjectId(userId);
    if (plan.assignedUserId && plan.assignedUserId.toString() === userObjectId.toString()) {
      return;
    }
    if (plan.assignedWorkspaceId) {
      const memberRow = await this.subscriptionModel.db.collection('workspacemembers').findOne({
        workspaceId: plan.assignedWorkspaceId,
        userId: userObjectId,
        status: 'active',
        role: { $in: ['owner', 'admin'] },
      });
      if (memberRow) return;
    }
    throw new ForbiddenException('This custom plan is not available for your account');
  }

  private async findReusableOpenMandate(args: {
    userId: string;
    planId: string;
    billingCycle: BillingCycle;
    totalPaise: number;
  }): Promise<SubscriptionPayment | null> {
    const cutoff = new Date(Date.now() - SubscriptionMandateService.OPEN_MANDATE_REUSE_WINDOW_MS);
    return this.paymentModel
      .findOne({
        userId: new Types.ObjectId(args.userId),
        planId: new Types.ObjectId(args.planId),
        billingCycle: args.billingCycle,
        paymentMode: 'recurring',
        status: 'created',
        gateway: 'razorpay',
        totalPaise: args.totalPaise,
        gatewaySubscriptionId: { $exists: true, $ne: null },
        createdAt: { $gte: cutoff },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  private async persistPendingSubscription(args: {
    userId: string;
    planId: string;
    billingCycle: 'monthly' | 'yearly';
    razorpaySubscriptionId: string;
    plan: Plan;
  }): Promise<Subscription> {
    return this.subscriptionModel.create({
      userId: new Types.ObjectId(args.userId),
      planId: new Types.ObjectId(args.planId),
      billingCycle: args.billingCycle,
      // Pending — flips to 'active' on subscription.activated webhook.
      // Survives the partial-unique (userId,status:'active'/'trial')
      // index because 'pending' is in neither set.
      status: 'pending',
      razorpaySubscriptionId: args.razorpaySubscriptionId,
      source: 'self',
      // Snapshot entitlements at mandate creation time. The active
      // subscription still owns runtime entitlements until activation.
      product: args.plan.product,
      purchasedEntitlements: args.plan.entitlements,
      appliedEntitlements: args.plan.entitlements,
    });
  }

  private async findUserMandate(
    userId: string,
    opts: { includePaused?: boolean } = {},
  ): Promise<Subscription> {
    const statusFilter: string[] = ['active', 'past_due', 'grace_period'];
    if (opts.includePaused) statusFilter.push('paused');

    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        razorpaySubscriptionId: { $exists: true, $ne: null },
        status: { $in: statusFilter },
      })
      .sort({ createdAt: -1 })
      .exec();
    if (!sub) {
      throw new NotFoundException('No active mandate found for this account');
    }
    if (!sub.razorpaySubscriptionId) {
      throw new NotFoundException('Mandate is missing gateway handle');
    }
    return sub;
  }

  private toActionResponse(sub: Subscription): MandateActionResponse {
    return {
      subscriptionId: String(sub._id),
      status: sub.status,
      razorpaySubscriptionId: sub.razorpaySubscriptionId,
    };
  }

  private isStaleCustomerError(err: unknown): boolean {
    if (!(err instanceof RazorpayApiError)) return false;
    const lc = `${err.code} ${err.description}`.toLowerCase();
    return lc.includes('customer') && lc.includes('not') && lc.includes('exist');
  }

  // ── coupon helpers (D1e) ────────────────────────────────────────────

  /**
   * Resolve coupons for a mandate flow. Customer codes win over
   * auto-apply. Empty resolution when neither codes nor a campaign key
   * are supplied.
   */
  private async resolveMandateCoupons(args: {
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
    return { resolved: [], totalDiscountPaise: 0, warnings: [] };
  }

  /**
   * Create a one-shot discounted Razorpay Plan for a mandate's first
   * cycle. Not cached on `Plan` — coupon stacks vary per checkout, so
   * caching by post-discount price would still need a stack key. We
   * accept the orphan cost (Razorpay plans are free) for simplicity.
   */
  private async createDiscountedRazorpayPlan(
    plan: Plan,
    cycle: 'monthly' | 'yearly',
    discountedTotalPaise: number,
    couponCodes: string,
  ): Promise<string> {
    const created = await this.razorpay.createPlan({
      amountPaise: discountedTotalPaise,
      currency: 'INR',
      name: `${plan.name} (${cycle}) — promo`,
      description: `ManekHR ${plan.name} ${cycle} (first-cycle discount via ${couponCodes})`,
      period: cycle,
      interval: 1,
      notes: {
        localPlanId: String(plan._id),
        cycle,
        couponCodes,
        discountedTotalPaise: String(discountedTotalPaise),
        kind: 'first_cycle_discount',
      },
    });
    return created.id;
  }
}
