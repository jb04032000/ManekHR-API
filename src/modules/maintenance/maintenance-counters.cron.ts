import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { hourBucket } from '../../common/scheduler/period-key';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

/**
 * MaintenanceCountersCron — fires at 02:00 LOCAL time in each workspace's tz.
 *
 * Refreshes hours/output cached counters (`hoursAccumulated`,
 * `outputAccumulated`) and recomputes `nextDueAt` for every active
 * `hours_based` + `output_based` MaintenanceSchedule for workspaces whose
 * local hour (per `workspace.timezone`) currently equals 02.
 *
 * HI-02 fix (24-REVIEW.md HI-02): switched from a single 02:00 IST trigger
 * to an hourly cron + per-workspace tz local-hour gate. Mirrors RFM /
 * GREETINGS_DISPATCH pattern (cron.constants.ts §17 Pattern 1: @Cron
 * timezone is class-load static, so we fan out per workspace inside the
 * handler).
 *
 * Implementation notes:
 *  - Hourly cron pinned to IST so the schedule is deterministic; the IST
 *    pin is the dispatcher tick, not the business rule.
 *  - For each workspace whose local hour === 2 we delegate to
 *    `MaintenanceSchedulesService.refreshDerivedCounters(wsId)`. This
 *    keeps the existing per-workspace failure isolation contract and
 *    avoids the platform-wide `refreshAllDerivedCounters` fan-out (which
 *    ignored timezones entirely).
 *  - `ScheduleModule.forRoot()` is registered globally (SalaryModule) — no
 *    re-registration needed here.
 */
const TARGET_LOCAL_HOUR = 2;

@Injectable()
export class MaintenanceCountersCron {
  private readonly logger = new Logger(MaintenanceCountersCron.name);

  constructor(
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    private readonly schedulesService: MaintenanceSchedulesService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Maintenance derived-counter refresh
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per hour. See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (IST registration); per-workspace tz filter fires at local
   *              hour 02:00 (HI-02 - @Cron tz is class-load static).
   * Idempotent:  YES - convergent recompute: refreshDerivedCounters overwrites each
   *              schedule's hoursAccumulated/outputAccumulated/nextDueAt via updateOne
   *              (no append), so a re-run/retry produces the same end state. Tier B
   *              (double-run only re-derives, no money/message side effect).
   * Reads:       workspaces, maintenance_schedules + their usage sources
   * Writes:      maintenance_schedules derived counters (materialized only)
   * Missed run:  Self-heals - the next hour while local hour is still 02 recomputes;
   *              counters are derived from live usage, so a skip never corrupts them.
   * Owner:       maintenance
   */
  @Cron(CRON_SCHEDULES.EVERY_HOUR, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.MAINTENANCE_COUNTER_REFRESH,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.MAINTENANCE_COUNTER_REFRESH, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();
    let workspaces: Array<{ _id: any; timezone?: string }>;
    try {
      workspaces = (await this.workspaceModel.find({}).select('_id timezone').lean().exec()) as any;
    } catch (err) {
      this.logger.error('MaintenanceCountersCron: failed to load workspaces', err);
      return;
    }

    let processed = 0;
    let skipped = 0;
    for (const ws of workspaces) {
      const tz = ws.timezone || 'Asia/Kolkata';
      if (!this.shouldRunInWorkspaceNow(now, tz)) {
        skipped++;
        continue;
      }
      try {
        await this.schedulesService.refreshDerivedCounters(String(ws._id));
        processed++;
      } catch (err) {
        this.logger.error(`MaintenanceCountersCron: workspace ${String(ws._id)} failed`, err);
      }
    }

    if (processed > 0) {
      this.logger.log(
        `MaintenanceCountersCron complete: processed=${processed}, skipped=${skipped}`,
      );
    }
  }

  /**
   * HI-02 helper — true when workspace's local hour equals TARGET_LOCAL_HOUR.
   * Exposed for unit tests (mirrors RfmCron.shouldRunInWorkspaceNow).
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
    return localHour === TARGET_LOCAL_HOUR;
  }
}
