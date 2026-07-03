/**
 * Phase 17 / FIN-16-01 D-06 — RFM Segmenter cron.
 *
 * Pattern 1 (research): @Cron timezone is class-load static, so we register
 * an HOURLY cron at IST and filter per-workspace tz INSIDE the handler using
 * Intl.DateTimeFormat. Fires at hour=2 in each workspace's local timezone
 * (CONTEXT D-06 — 02:00 local).
 *
 * Pitfall 9 (T-17-W1A-08): tz misfire prevented by per-ws filter.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import pLimit from 'p-limit';
import { RfmSegmenterService } from './rfm-segmenter.service';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { hourBucket } from '../../../../common/scheduler/period-key';

@Injectable()
export class RfmCron {
  private readonly logger = new Logger(RfmCron.name);

  constructor(
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    private readonly segmenter: RfmSegmenterService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - RFM party segmenter
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per hour. See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (IST registration); per-workspace tz filter fires at
   *              local hour 02:00 (Pattern 1 - @Cron tz is class-load static).
   * Idempotent:  YES - convergent recompute: per workspace the segmenter overwrites
   *              each party's RFM scores/segment via updateOne/bulkWrite (no append),
   *              so a re-run/retry produces the same end state. Tier B (double-run
   *              only re-segments, no money/message side effect).
   * Reads:       workspaces, parties, invoices/payments (per the segmenter)
   * Writes:      parties RFM fields (materialized scores only; no external effects)
   * Missed run:  Self-heals - the next hour while local hour is still 02 recomputes;
   *              a fully skipped day just delays the refresh, never corrupts it.
   * Owner:       finance/party-intelligence
   */
  // CRON_SCHEDULES.RFM_SEGMENTER is hourly; per-ws filter narrows to 02:00 local.
  @Cron(CRON_SCHEDULES.RFM_SEGMENTER, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.RFM_SEGMENTER,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.RFM_SEGMENTER, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();
    const runId = randomUUID();
    const workspaces = await this.workspaceModel
      .find({ isActive: true })
      .select('_id timezone')
      .lean();

    const limit = pLimit(8);
    await Promise.all(
      workspaces.map((ws: any) =>
        limit(async () => {
          const tz = ws.timezone || 'Asia/Kolkata';
          if (!this.shouldRunInWorkspaceNow(now, tz)) return;
          try {
            const summary = await this.segmenter.recompute(String(ws._id), { runId });
            this.logger.log(
              `RFM segmenter ws=${ws._id} runId=${runId} ` +
                `updated=${summary.updated} segmentChanges=${summary.segmentChanges} durationMs=${summary.durationMs}`,
            );
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? String(err);
            this.logger.warn(`RFM segmenter failed ws=${ws._id} runId=${runId}: ${msg}`);
          }
        }),
      ),
    );
  }

  /**
   * D-06 — fires at 02:00 local in each workspace's timezone.
   * Exposed as a method so unit tests can stub.
   */
  shouldRunInWorkspaceNow(now: Date, tz: string): boolean {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    });
    const parts = fmt.formatToParts(now);
    const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '';
    const localHour = parseInt(hourStr, 10) % 24;
    return localHour === 2;
  }
}
