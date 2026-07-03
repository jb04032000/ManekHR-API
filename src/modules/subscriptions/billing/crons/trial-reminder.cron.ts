import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../schemas/subscription.schema';
import { User } from '../../../users/schemas/user.schema';
import { MarketingService } from '../services/marketing.service';
import { BillingPolicyService } from '../services/billing-policy.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { dueReminderThresholds } from './trial-reminder.thresholds';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';

/**
 * D4 — trial-expiry reminder cron.
 *
 * Fires daily at midnight IST. For every active trial subscription whose
 * `trialEndsAt` falls within `BillingPolicy.trial.reminderEmailDaysBeforeEnd`
 * days from now, it sends a small CADENCE of nudges (NOT a daily email): a
 * nudge fires only when the trial's `daysRemaining` lands on one of the
 * derived thresholds (default 5/2/1 days out — see
 * `trial-reminder.thresholds.ts`). Each threshold is deduped independently via
 * the per-threshold key `trial:<subscriptionId>:d<thresholdDay>`, so a trial
 * gets ~2-3 nudges total across its final days, never a daily barrage.
 *
 * The post-expiry "you're now on Free" notice is NOT sent here — it fires from
 * `SubscriptionsService.downgradeToBasePlan` (the single choke point for "a
 * trial just became Free"), because the downgrade clears `trialEndsAt` and the
 * cron can no longer find those rows.
 *
 * Timezone: IST. Reminders should land in customers' inboxes during
 * Indian business hours.
 */
@Injectable()
export class TrialReminderCron {
  private readonly logger = new Logger(TrialReminderCron.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly marketing: MarketingService,
    private readonly policyService: BillingPolicyService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Trial-expiry reminder (D4)
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    daily at midnight IST - land in inboxes during IST business hours.
   * Idempotent:  YES - MarketingService reserves a MarketingCampaignDispatch row
   *              keyed `trial:<subId>:d<thresholdDay>` via unique-index insert,
   *              so each nudge threshold sends at most once; a re-run or retry is
   *              a no-op (verified in marketing.service.ts dispatch()).
   * Reads:       subscriptions, users, billing policy
   * Writes:      marketing_campaign_dispatch (claim); sends the due nudge(s) for
   *              today's daysRemaining (a small 5/2/1-day cadence, not daily)
   * Missed run:  Self-heals - the next day re-scans the reminder window; a missed
   *              threshold day simply skips that one nudge (exact-day match), the
   *              remaining thresholds still fire.
   * Owner:       subscriptions/billing
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, { timeZone: CRON_TIMEZONES.IST })
  async run() {
    await this.singleFlight.runExclusive(CronJobKey.BILLING_TRIAL_REMINDER, dayBucket(), () =>
      this.process(),
    );
  }

  private async process() {
    const policy = await this.policyService.getPolicy();
    if (!policy.marketing?.sendTrialReminder) {
      this.logger.debug('Trial reminder disabled in policy — skipping');
      return;
    }

    const reminderDays = policy.trial?.reminderEmailDaysBeforeEnd ?? 5;
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + reminderDays);

    const trials = await this.subscriptionModel
      .find({
        status: 'trial',
        trialEndsAt: { $gte: now, $lte: cutoff },
      })
      .populate({ path: 'planId', select: 'name' })
      .lean()
      .exec();

    if (trials.length === 0) {
      this.logger.debug('No trial subscriptions due for reminder');
      return;
    }

    this.logger.log(
      `Trial-reminder cron: ${trials.length} candidate(s) within ${reminderDays}d window`,
    );

    let sent = 0;
    for (const sub of trials) {
      try {
        const trialEndsAt = sub.trialEndsAt as unknown as Date;
        const daysRemaining = Math.max(
          1,
          Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
        );

        // Only fire when today lands on a nudge threshold derived from the
        // window (default 5/2/1 days out). In-between days produce no email —
        // this is what makes the cadence a few nudges, not a daily barrage.
        const dueThresholds = dueReminderThresholds(daysRemaining, reminderDays);
        if (dueThresholds.length === 0) continue;

        const user = await this.userModel.findById(sub.userId).select('name email').lean().exec();
        if (!user?.email) continue;

        const planName = (sub.planId as unknown as { name?: string })?.name ?? 'Your ManekHR';

        for (const thresholdDay of dueThresholds) {
          // Each threshold dedups on its own `trial:<subId>:d<thresholdDay>`
          // key inside MarketingService, so the same nudge never repeats.
          const wasSent = await this.marketing.sendTrialReminder({
            userId: String(sub.userId),
            subscriptionId: String((sub as { _id: Types.ObjectId })._id),
            recipientName: user.name ?? 'there',
            recipientEmail: user.email,
            planName,
            trialEndsAt,
            daysRemaining,
            thresholdDay,
            upgradeUrl: this.marketing.buildAppUrl('/dashboard/subscription/plans'),
          });
          if (wasSent) sent += 1;
        }
      } catch (e) {
        const err = e as { message?: string };
        this.logger.error(
          `Trial reminder failed for sub=${String((sub as { _id: Types.ObjectId })._id)}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Trial-reminder cron complete: ${sent} nudge(s) sent / ${trials.length} candidates`,
    );
  }
}
