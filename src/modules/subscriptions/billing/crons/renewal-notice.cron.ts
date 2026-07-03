import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../schemas/subscription.schema';
import { Plan } from '../../schemas/plan.schema';
import { User } from '../../../users/schemas/user.schema';
import { PricingService } from '../services/pricing.service';
import { MarketingService } from '../services/marketing.service';
import { BillingPolicyService } from '../services/billing-policy.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';

/**
 * D4 — pre-renewal notice cron.
 *
 * Fires daily at midnight IST. For every active mandate-bound
 * subscription whose `currentPeriodEnd` falls within
 * `BillingPolicy.marketing.renewalNoticeDaysBeforeEnd` days, sends a
 * heads-up email so the customer can pause/cancel/change plans
 * before being auto-charged.
 *
 * Idempotency: keyed on `renewal:<subscriptionId>:<periodEndStamp>`,
 * so a customer is reminded exactly once per renewal cycle. If they
 * change plans (which advances currentPeriodEnd), the next cycle
 * gets a fresh reminder because the stamp changes.
 *
 * Skips: one-time payment subs (no auto-renew), already cancelled
 * subs (currentPeriodEnd is final), grace-period subs (handled by
 * dunning emails).
 */
@Injectable()
export class RenewalNoticeCron {
  private readonly logger = new Logger(RenewalNoticeCron.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly pricing: PricingService,
    private readonly marketing: MarketingService,
    private readonly policyService: BillingPolicyService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Pre-renewal notice (D4)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at midnight IST - heads-up before an auto-charge.
   * Idempotent:  YES - MarketingService reserves a dispatch row keyed
   *              `renewal:<subId>:<periodEndStamp>` via unique-index insert; a
   *              re-run or retry is a no-op. A plan change advances the stamp, so
   *              the next cycle gets a fresh notice.
   * Reads:       subscriptions, plans, users, billing policy
   * Writes:      marketing_campaign_dispatch (claim); sends ONE renewal-notice email
   * Missed run:  Self-heals - the next day re-scans the notice window.
   * Owner:       subscriptions/billing
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, { timeZone: CRON_TIMEZONES.IST })
  async run() {
    await this.singleFlight.runExclusive(CronJobKey.BILLING_RENEWAL_NOTICE, dayBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    const policy = await this.policyService.getPolicy();
    if (!policy.marketing?.sendRenewalNotice) {
      this.logger.debug('Renewal notice disabled in policy — skipping');
      return;
    }

    const noticeDays = policy.marketing.renewalNoticeDaysBeforeEnd ?? 3;
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + noticeDays);

    const subs = await this.subscriptionModel
      .find({
        status: 'active',
        razorpaySubscriptionId: { $exists: true, $ne: null },
        currentPeriodEnd: { $gte: now, $lte: cutoff },
      })
      .lean()
      .exec();

    if (subs.length === 0) {
      this.logger.debug('No mandate subs renewing within window');
      return;
    }

    this.logger.log(
      `Renewal-notice cron: ${subs.length} candidate(s) within ${noticeDays}d window`,
    );

    let sent = 0;
    for (const sub of subs) {
      try {
        const [user, plan] = await Promise.all([
          this.userModel.findById(sub.userId).select('name email').lean().exec(),
          this.planModel.findById(sub.planId).exec(),
        ]);
        if (!user?.email || !plan) continue;

        const cycle = sub.billingCycle as 'monthly' | 'yearly';
        const quote = this.pricing.computeQuote(plan, cycle);
        const periodEnd = sub.currentPeriodEnd as unknown as Date;
        const daysUntilRenewal = Math.max(
          1,
          Math.ceil((periodEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
        );

        const wasSent = await this.marketing.sendRenewalNotice({
          userId: String(sub.userId),
          subscriptionId: String((sub as { _id: Types.ObjectId })._id),
          recipientName: user.name ?? 'there',
          recipientEmail: user.email,
          planName: plan.name,
          currentPeriodEnd: periodEnd,
          daysUntilRenewal,
          amountPaise: quote.totalPaise,
          manageUrl: this.marketing.buildAppUrl('/dashboard/subscription/payment-method'),
        });
        if (wasSent) sent += 1;
      } catch (e) {
        const err = e as { message?: string };
        this.logger.error(
          `Renewal notice failed for sub=${String((sub as { _id: Types.ObjectId })._id)}: ${err.message}`,
        );
      }
    }

    this.logger.log(`Renewal-notice cron complete: ${sent} sent / ${subs.length} candidates`);
  }
}
