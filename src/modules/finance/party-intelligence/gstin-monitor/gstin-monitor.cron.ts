/**
 * Phase 17 / FIN-16-02 D-11 — GSTIN risk monitor cron.
 *
 * Pattern 1 (research): @Cron timezone is class-load static, so we register
 * an HOURLY cron at IST and filter per-workspace tz INSIDE the handler using
 * Intl.DateTimeFormat. Fires at hour=3, weekday=Sun in each workspace's
 * local timezone (CONTEXT D-11 — Sunday 03:00 local).
 *
 * Pitfall 9 mitigation (T-17-W1B-05): tz misfire prevented by per-ws filter.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import pLimit from 'p-limit';
import type { Workspace } from '../../../workspaces/schemas/workspace.schema';
import { GstinMonitorService } from './gstin-monitor.service';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { hourBucket } from '../../../../common/scheduler/period-key';

@Injectable()
export class GstinMonitorCron {
  private readonly logger = new Logger(GstinMonitorCron.name);

  constructor(
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<Workspace>,
    private readonly monitor: GstinMonitorService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - GSTIN risk monitor
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per hour. See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly on Sundays (IST registration); per-workspace tz filter
   *              fires at local Sunday 03:00 (Pattern 1 - @Cron tz is static).
   * Idempotent:  YES - per workspace the monitor overwrites each party's GSTIN
   *              status/risk fields via updateOne (no append), so a re-run/retry
   *              converges to the same end state. The upstream GST status read is a
   *              query, not a mutation. Tier B (double-run only re-checks; the only
   *              cost is duplicate external GST API calls, no money/message effect).
   * Reads:       workspaces, parties; external GSTIN status API
   * Writes:      parties GSTIN status/risk fields (no external side effects)
   * Missed run:  Self-heals - the next hour while local Sunday hour is still 03
   *              re-checks; a skipped Sunday defers the weekly check by a week.
   * Owner:       finance/party-intelligence
   */
  // CRON_SCHEDULES.GSTIN_MONITOR is '0 * * * 0' (hourly on Sundays). The
  // per-ws Intl.DateTimeFormat filter inside still narrows to local hour===3
  // in each workspace's timezone — research §Pattern 1.
  @Cron(CRON_SCHEDULES.GSTIN_MONITOR, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.GSTIN_MONITOR,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.GSTIN_MONITOR, hourBucket(), () =>
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
      workspaces.map((ws) =>
        limit(async () => {
          const tz = ws.timezone || 'Asia/Kolkata';
          if (!this.shouldRunInWorkspaceNow(now, tz)) return;
          try {
            const summary = await this.monitor.runForWorkspace(String(ws._id), runId);
            this.logger.log(
              `GSTIN monitor ws=${String(ws._id)} runId=${runId} ` +
                `checked=${summary.checked} updated=${summary.updated} errored=${summary.errored}`,
            );
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? String(err);
            this.logger.warn(`GSTIN monitor failed ws=${String(ws._id)} runId=${runId}: ${msg}`);
          }
        }),
      ),
    );
  }

  /**
   * D-11: fires at Sunday 03:00 in each workspace's local tz.
   * Exposed as a method so unit tests can stub via vi.useFakeTimers.
   */
  shouldRunInWorkspaceNow(now: Date, tz: string): boolean {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
      timeZone: tz,
    });
    const parts = fmt.formatToParts(now);
    const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '';
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    // Intl can return '24' for midnight in some impls — coerce to 0.
    const hour = parseInt(hourStr, 10) % 24;
    return hour === 3 && weekday === 'Sun';
  }
}
