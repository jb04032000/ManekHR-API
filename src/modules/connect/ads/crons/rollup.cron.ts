import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdImpression } from '../schemas/ad-impression.schema';
import { AdClick } from '../schemas/ad-click.schema';
import { AdDailyRollup } from '../schemas/ad-daily-rollup.schema';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

/**
 * RollupCron - runs nightly at 02:00 UTC.
 *
 * Aggregates yesterday's impression and click rows (bucketed to IST calendar
 * day) into one `AdDailyRollup` document per campaign. The upsert is keyed
 * on `{ campaignId, date }` so the cron is safe to re-run (idempotent).
 *
 * IST = UTC + 5h30m (330 minutes). "Yesterday in IST" means:
 *   - Shift the current UTC wall-clock by +330 minutes to get IST wall-clock.
 *   - Subtract one calendar day.
 *   - Format as YYYY-MM-DD.
 *   - Map that IST day's [00:00, 24:00) back to UTC bounds for the Mongo query.
 *
 * The public `tick(nowMs)` method is extracted from `run()` so tests can
 * call it directly without triggering the @Cron decorator or requiring a
 * full NestJS module context.
 */

// ---------------------------------------------------------------------------
// Pure helper - exported for direct unit testing
// ---------------------------------------------------------------------------

export interface ComputeRatesInput {
  impressions: number;
  viewableImpressions: number;
  clicks: number;
  validClicks: number;
  spend: number;
}

export interface ComputeRatesOutput {
  ctr: number;
  viewabilityRate: number;
}

/**
 * Derives click-through rate and viewability rate from raw counts.
 * Both values are 0 when impressions = 0 (zero-safe, no NaN/Infinity).
 * `validClicks` and `spend` are accepted in the input shape for symmetry
 * with the rollup record but do not affect the computed rates.
 */
export function computeRates(input: ComputeRatesInput): ComputeRatesOutput {
  return {
    ctr: input.impressions > 0 ? input.clicks / input.impressions : 0,
    viewabilityRate: input.impressions > 0 ? input.viewableImpressions / input.impressions : 0,
  };
}

// ---------------------------------------------------------------------------
// IST date helpers (private to module, exported for test access via named export)
// ---------------------------------------------------------------------------

const IST_OFFSET_MINUTES = 330; // UTC + 5h30m

/**
 * Returns the YYYY-MM-DD IST date string for "yesterday" relative to nowMs,
 * plus the UTC [start, end) instants of that IST calendar day.
 */
export function yesterdayIst(nowMs: number): {
  dateStr: string;
  utcStart: Date;
  utcEnd: Date;
} {
  // Shift nowMs into IST wall-clock milliseconds.
  const istNowMs = nowMs + IST_OFFSET_MINUTES * 60 * 1000;

  // Truncate to IST midnight of today, then subtract one day to get yesterday.
  const istToday = new Date(istNowMs);
  istToday.setUTCHours(0, 0, 0, 0);
  const istYesterday = new Date(istToday.getTime() - 24 * 60 * 60 * 1000);

  // Format as YYYY-MM-DD.
  const year = istYesterday.getUTCFullYear();
  const month = String(istYesterday.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istYesterday.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  // Map IST midnight back to UTC: subtract the IST offset.
  const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
  const utcStart = new Date(istYesterday.getTime() - offsetMs);
  const utcEnd = new Date(utcStart.getTime() + 24 * 60 * 60 * 1000);

  return { dateStr, utcStart, utcEnd };
}

// ---------------------------------------------------------------------------
// Cron class
// ---------------------------------------------------------------------------

@Injectable()
export class RollupCron {
  constructor(
    @InjectModel(AdImpression.name) private readonly impressionModel: Model<AdImpression>,
    @InjectModel(AdClick.name) private readonly clickModel: Model<AdClick>,
    @InjectModel(AdDailyRollup.name) private readonly rollupModel: Model<AdDailyRollup>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Ads daily rollup
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 02:00 UTC - aggregate yesterday's (IST-day) impressions +
   *              clicks into one rollup doc per campaign.
   * Idempotent:  YES - upsert keyed on { campaignId, date } with $set only, so a
   *              re-run/retry recomputes the same totals into the same doc. Tier B
   *              (double-run only re-aggregates, no money/message side effect).
   * Reads:       ad_impressions, ad_clicks
   * Writes:      ad_daily_rollups (materialized aggregates only; no side effects)
   * Missed run:  A skipped day leaves no rollup for that date until backfilled; the
   *              next run only covers its own yesterday (no automatic catch-up).
   * Owner:       connect/ads
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: CronJobKey.ADS_ROLLUP })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ADS_ROLLUP, dayBucket(), () =>
      this.tick(Date.now()),
    );
  }

  async tick(nowMs: number): Promise<void> {
    const { dateStr, utcStart, utcEnd } = yesterdayIst(nowMs);

    // Aggregate impressions per campaign in yesterday's IST window.
    const impressionBuckets: Array<{
      _id: string;
      impressions: number;
      viewableImpressions: number;
      spend: number;
    }> = await this.impressionModel.aggregate([
      { $match: { servedAt: { $gte: utcStart, $lt: utcEnd } } },
      {
        $group: {
          _id: '$campaignId',
          impressions: { $sum: 1 },
          viewableImpressions: { $sum: { $cond: ['$viewable', 1, 0] } },
          spend: { $sum: '$chargeAmount' },
        },
      },
    ]);

    // Aggregate clicks per campaign in yesterday's IST window.
    // CN-ADS-2 (Bucket 3): also SUM the click charge (`chargeAmount`). CPC
    // campaigns bill on click, not impression, so their spend lives entirely in
    // AdClick — previously it was never summed, and every CPC campaign rolled up
    // spend:0. `spend` here is the CPC portion; the upsert adds it to the CPM
    // (impression) portion below.
    const clickBuckets: Array<{
      _id: string;
      clicks: number;
      validClicks: number;
      spend: number;
    }> = await this.clickModel.aggregate([
      { $match: { clickedAt: { $gte: utcStart, $lt: utcEnd } } },
      {
        $group: {
          _id: '$campaignId',
          clicks: { $sum: 1 },
          validClicks: { $sum: { $cond: ['$valid', 1, 0] } },
          spend: { $sum: '$chargeAmount' },
        },
      },
    ]);

    // Build a click lookup keyed by campaignId string for O(1) merge.
    const clickMap = new Map<string, { clicks: number; validClicks: number; spend: number }>();
    for (const b of clickBuckets) {
      clickMap.set(String(b._id), { clicks: b.clicks, validClicks: b.validClicks, spend: b.spend });
    }

    // Build an impression lookup + the UNION of campaign ids seen on either side.
    // CN-ADS-2: iterate the union (not just impression buckets) so a CPC campaign
    // that had CLICKS but ZERO impressions in the window still gets a rollup row
    // with its click spend — previously such a campaign was skipped entirely.
    const impMap = new Map<
      string,
      { _id: unknown; impressions: number; viewableImpressions: number; spend: number }
    >();
    for (const imp of impressionBuckets) impMap.set(String(imp._id), imp);
    const allCampaignIds = new Set<string>([...impMap.keys(), ...clickMap.keys()]);

    // Upsert one rollup document per campaign (impression-side + click-side).
    for (const campaignId of allCampaignIds) {
      const imp = impMap.get(campaignId) ?? {
        _id: campaignId,
        impressions: 0,
        viewableImpressions: 0,
        spend: 0,
      };
      const clickData = clickMap.get(campaignId) ?? { clicks: 0, validClicks: 0, spend: 0 };
      // Total spend = CPM (impression) spend + CPC (click) spend. A campaign is
      // one billing model, so exactly one side is non-zero in practice, but
      // summing both is correct and future-proof for a mixed campaign.
      const spend = imp.spend + clickData.spend;

      const { ctr, viewabilityRate } = computeRates({
        impressions: imp.impressions,
        viewableImpressions: imp.viewableImpressions,
        clicks: clickData.clicks,
        validClicks: clickData.validClicks,
        spend,
      });

      await this.rollupModel.updateOne(
        { campaignId: imp._id, date: dateStr },
        {
          $set: {
            impressions: imp.impressions,
            viewableImpressions: imp.viewableImpressions,
            spend,
            clicks: clickData.clicks,
            validClicks: clickData.validClicks,
            ctr,
            viewabilityRate,
          },
        },
        { upsert: true },
      );
    }
  }
}
