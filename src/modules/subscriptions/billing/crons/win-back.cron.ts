import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../schemas/subscription.schema';
import { Coupon } from '../schemas/coupon.schema';
import { User } from '../../../users/schemas/user.schema';
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
 * D4 — win-back cron.
 *
 * Fires daily at midnight IST. Finds subscriptions that were
 * cancelled/expired exactly `BillingPolicy.marketing.winBackAfterDays`
 * days ago and sends a re-engagement email. Includes the active
 * auto-apply coupon (campaign key `winback`) when one exists, so
 * marketing can rotate the offer without code changes.
 *
 * Idempotency: keyed on `winback:<subscriptionId>:<cancelledAtStamp>`,
 * so a customer who cancels multiple subscriptions over time gets
 * one win-back per cancellation event.
 *
 * Skips: customers who have a fresh active subscription (no need to
 * win them back — they already came back).
 */
@Injectable()
export class WinBackCron {
  private readonly logger = new Logger(WinBackCron.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Coupon.name) private readonly couponModel: Model<Coupon>,
    private readonly marketing: MarketingService,
    private readonly policyService: BillingPolicyService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Win-back re-engagement (D4)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at midnight IST - targets subs cancelled N days ago.
   * Idempotent:  YES - MarketingService reserves a dispatch row keyed
   *              `winback:<subId>:<cancelledAtStamp>` via unique-index insert; a
   *              re-run or retry is a no-op. One win-back per cancellation event.
   * Reads:       subscriptions, users, coupons, billing policy
   * Writes:      marketing_campaign_dispatch (claim); sends ONE win-back email
   * Missed run:  Mostly self-heals - the day-window scan re-targets the same
   *              cohort next run; a cohort whose window fully passed is not
   *              retried (acceptable: a stale win-back has little value).
   * Owner:       subscriptions/billing
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, { timeZone: CRON_TIMEZONES.IST })
  async run() {
    await this.singleFlight.runExclusive(CronJobKey.BILLING_WIN_BACK, dayBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    const policy = await this.policyService.getPolicy();
    if (!policy.marketing?.sendWinBack) {
      this.logger.debug('Win-back disabled in policy — skipping');
      return;
    }

    const afterDays = policy.marketing.winBackAfterDays ?? 14;
    // Find cancellations that landed inside today's IST window so we
    // hit each cancelled customer exactly once after `afterDays`.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - afterDays);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCHours(23, 59, 59, 999);

    // Active win-back coupon (most recent unexpired auto-apply with
    // campaignKey starting with 'winback').
    const winbackCoupon = await this.couponModel
      .findOne({
        isActive: true,
        autoApplyCampaignKey: { $regex: /^winback/i },
        $and: [
          {
            $or: [
              { validFrom: { $exists: false } },
              { validFrom: null },
              { validFrom: { $lte: new Date() } },
            ],
          },
          {
            $or: [
              { validUntil: { $exists: false } },
              { validUntil: null },
              { validUntil: { $gte: new Date() } },
            ],
          },
        ],
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const cancelled = await this.subscriptionModel
      .find({
        status: { $in: ['cancelled', 'expired'] },
        cancelledAt: { $gte: dayStart, $lte: dayEnd },
      })
      .populate({ path: 'planId', select: 'name' })
      .lean()
      .exec();

    if (cancelled.length === 0) {
      this.logger.debug('No cancellations to win back today');
      return;
    }

    this.logger.log(`Win-back cron: ${cancelled.length} candidate(s) cancelled ${afterDays}d ago`);

    let sent = 0;
    for (const sub of cancelled) {
      try {
        // Skip when customer already has a fresh active sub.
        const hasActive = await this.subscriptionModel
          .exists({
            userId: sub.userId,
            status: { $in: ['active', 'trial', 'pending'] },
          })
          .exec();
        if (hasActive) continue;

        const user = await this.userModel.findById(sub.userId).select('name email').lean().exec();
        if (!user?.email) continue;

        const planName = (sub.planId as unknown as { name?: string })?.name ?? 'ManekHR';
        const cancelledAt = sub.cancelledAt as unknown as Date;

        const wasSent = await this.marketing.sendWinBack({
          userId: String(sub.userId),
          subscriptionId: String((sub as { _id: Types.ObjectId })._id),
          recipientName: user.name ?? 'there',
          recipientEmail: user.email,
          planName,
          cancelledAt,
          reactivateUrl: this.marketing.buildAppUrl(
            winbackCoupon?.autoApplyCampaignKey
              ? `/dashboard/subscription/plans?promo=${encodeURIComponent(winbackCoupon.autoApplyCampaignKey)}`
              : '/dashboard/subscription/plans',
          ),
          promoCode: winbackCoupon?.code,
          promoDescription: winbackCoupon ? this.describeCoupon(winbackCoupon) : undefined,
        });
        if (wasSent) sent += 1;
      } catch (e) {
        const err = e as { message?: string };
        this.logger.error(
          `Win-back failed for sub=${String((sub as { _id: Types.ObjectId })._id)}: ${err.message}`,
        );
      }
    }

    this.logger.log(`Win-back cron complete: ${sent} sent / ${cancelled.length} candidates`);
  }

  private describeCoupon(c: Coupon): string {
    if (c.discountType === 'percentage') {
      return `${c.valueOrPaise}% off your next subscription`;
    }
    if (c.discountType === 'fixed_amount') {
      return `₹${(c.valueOrPaise / 100).toLocaleString('en-IN')} off`;
    }
    return `Special price ₹${(c.valueOrPaise / 100).toLocaleString('en-IN')}`;
  }
}
