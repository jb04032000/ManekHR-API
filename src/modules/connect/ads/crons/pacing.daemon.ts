import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdCampaign } from '../schemas/ad-campaign.schema';
import { AdImpression } from '../schemas/ad-impression.schema';
import { PacingRepoRedis } from '../services/pacing.repo';
import { targetImpressionsPerMinute, shouldThrottle } from '../lib/pacing';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { minuteBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

/**
 * PacingDaemon - runs every minute and throttles over-pacing campaigns.
 *
 * For each active campaign that has not yet passed its endAt, the daemon:
 *  1. Computes an avgCpm estimate (CPM campaigns use the bid directly; CPC
 *     campaigns use max(1, bid * 10) as a rough eCPM proxy).
 *  2. Calls targetImpressionsPerMinute to derive the ideal per-minute rate
 *     needed to exhaust the remaining budget evenly.
 *  3. Counts how many impressions were served in the last 60 seconds.
 *  4. If lastMinute > target * 1.2, sets a 60-second throttle key in Redis
 *     via PacingRepoRedis. AdDecisionService checks this key before serving.
 *
 * The throttle TTL of 60s means it auto-expires on the next cron tick if the
 * campaign naturally falls back within its pacing envelope.
 *
 * The public `tick(nowMs)` method is extracted from `run()` so it can be
 * called directly in unit tests without triggering the @Cron decorator or
 * requiring a full NestJS module context.
 */
@Injectable()
export class PacingDaemon {
  constructor(
    @InjectModel(AdCampaign.name) private readonly campaignModel: Model<AdCampaign>,
    @InjectModel(AdImpression.name) private readonly impressionModel: Model<AdImpression>,
    private readonly pacingRepo: PacingRepoRedis,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Ads pacing throttle daemon
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per minute. See docs/architecture/scheduler-contract.md.
   * Schedule:    every minute - throttle campaigns over-pacing their budget.
   * Idempotent:  YES - the only write is pacingRepo.setThrottle (a 60s Redis key
   *              SET); re-running sets the same key to the same value (convergent),
   *              and the key auto-expires next tick if the campaign falls back into
   *              its envelope. Tier B (no money/message side effect).
   * Reads:       ad_campaigns, ad_impressions
   * Writes:      Redis throttle keys only (read by AdDecisionService before serving)
   * Missed run:  A skipped minute means no throttle that minute; the next tick
   *              re-evaluates from live impression counts (self-correcting).
   * Owner:       connect/ads
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: CronJobKey.ADS_PACING })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ADS_PACING, minuteBucket(), () =>
      this.tick(Date.now()),
    );
  }

  async tick(nowMs: number): Promise<void> {
    const active = await this.campaignModel
      .find({ status: 'active', endAt: { $gt: new Date(nowMs) } })
      .lean();

    for (const c of active) {
      const minutesLeft = (new Date(c.endAt).getTime() - nowMs) / 60000;
      const budgetRemaining = c.totalBudget - c.budgetSpent;

      // avgCpm: for CPM campaigns use the bid directly (it is already CPM).
      // For CPC campaigns use max(1, bid * 10) as a rough eCPM proxy.
      // Passing the raw CPC bid to targetImpressionsPerMinute would produce
      // a target ~1000x too high (since the function divides by CPM, not CPC).
      const avgCpm = c.billingEvent === 'cpm' ? c.bid : Math.max(1, c.bid * 10);

      const target = targetImpressionsPerMinute(budgetRemaining, minutesLeft, avgCpm);

      const lastMinute = await this.impressionModel.countDocuments({
        campaignId: c._id,
        servedAt: { $gte: new Date(nowMs - 60000) },
      });

      if (shouldThrottle(lastMinute, target)) {
        await this.pacingRepo.setThrottle(String(c._id), 60);
      }
    }
  }
}
