import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { User } from '../../../users/schemas/user.schema';
import { MarketingService } from '../services/marketing.service';
import { BillingPolicyService } from '../services/billing-policy.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { hourBucket } from '../../../../common/scheduler/period-key';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';

/**
 * D4 — abandoned-checkout cron.
 *
 * Fires every hour. Finds SubscriptionPayment rows still in `created`
 * state (Razorpay order created but never captured) older than
 * `BillingPolicy.marketing.abandonedCheckoutAfterHours` and nudges the
 * user to come back and finish.
 *
 * Idempotency: keyed on `abandoned:<subscriptionPaymentId>`, so each
 * abandoned payment row triggers exactly one nudge. Even if the
 * customer abandons multiple sessions, the BE's 10-min reuse-window
 * dedup means at most one row per (user, plan, cycle, total) within
 * that window.
 *
 * Skips: rows whose Razorpay order has already been captured (status
 * flips to `authorised`/`captured` post-webhook), and rows older than
 * 7 days (assume the customer has truly walked away — flooding their
 * inbox is worse than letting it slide).
 */
@Injectable()
export class AbandonedCheckoutCron {
  private readonly logger = new Logger(AbandonedCheckoutCron.name);

  private static readonly MAX_AGE_DAYS = 7;

  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly marketing: MarketingService,
    private readonly policyService: BillingPolicyService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Abandoned-checkout nudge (D4)
   * Execution:   @Cron gated to worker role + Redis single-flight per hour.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (UTC) - nudge created-but-uncaptured orders past a delay.
   * Idempotent:  YES - MarketingService reserves a dispatch row keyed
   *              `abandoned:<paymentId>` via unique-index insert; a re-run or
   *              retry is a no-op. One nudge per abandoned payment row.
   * Reads:       subscription_payments, users, billing policy
   * Writes:      marketing_campaign_dispatch (claim); sends ONE nudge email
   * Missed run:  Self-heals - the next hour re-scans (rows stay eligible up to
   *              MAX_AGE_DAYS).
   * Owner:       subscriptions/billing
   */
  @Cron(CRON_SCHEDULES.EVERY_HOUR, { timeZone: CRON_TIMEZONES.UTC })
  async run() {
    await this.singleFlight.runExclusive(CronJobKey.BILLING_ABANDONED_CHECKOUT, hourBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    const policy = await this.policyService.getPolicy();
    if (!policy.marketing?.sendAbandonedCheckout) {
      this.logger.debug('Abandoned-checkout disabled — skipping');
      return;
    }

    const afterHours = policy.marketing.abandonedCheckoutAfterHours ?? 24;
    const now = new Date();
    const olderThan = new Date(now.getTime() - afterHours * 60 * 60 * 1000);
    const tooOld = new Date(
      now.getTime() - AbandonedCheckoutCron.MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
    );

    const candidates = await this.paymentModel
      .find({
        status: 'created',
        paymentMode: 'one_time',
        gateway: 'razorpay',
        gatewayPaymentLinkId: { $exists: false },
        createdAt: { $lte: olderThan, $gte: tooOld },
      })
      .populate({ path: 'planId', select: 'name' })
      .lean()
      .exec();

    if (candidates.length === 0) {
      this.logger.debug('No abandoned-checkout candidates');
      return;
    }

    this.logger.log(
      `Abandoned-checkout cron: ${candidates.length} candidate(s) older than ${afterHours}h`,
    );

    let sent = 0;
    for (const payment of candidates) {
      try {
        const user = await this.userModel
          .findById(payment.userId)
          .select('name email')
          .lean()
          .exec();
        if (!user?.email) continue;

        const planName = (payment.planId as unknown as { name?: string })?.name ?? 'ManekHR';

        const wasSent = await this.marketing.sendAbandonedCheckout({
          userId: String(payment.userId),
          paymentId: String((payment as { _id: Types.ObjectId })._id),
          recipientName: user.name ?? 'there',
          recipientEmail: user.email,
          planName,
          totalPaise: payment.totalPaise,
          resumeUrl: this.marketing.buildAppUrl('/dashboard/subscription/plans'),
        });
        if (wasSent) sent += 1;
      } catch (e) {
        const err = e as { message?: string };
        this.logger.error(
          `Abandoned-checkout email failed for payment=${String((payment as { _id: Types.ObjectId })._id)}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Abandoned-checkout cron complete: ${sent} sent / ${candidates.length} candidates`,
    );
  }
}
