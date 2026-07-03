/**
 * Phase 17 / FIN-16-05 D-26 — GreetingsCron.
 *
 * Pattern 1 (research): @Cron timezone is class-load static. We register an
 * HOURLY cron at IST and filter per-workspace tz INSIDE the handler using
 * Intl.DateTimeFormat. Fires at hour=9 in each workspace's local timezone.
 *
 * Pitfall 9 (T-17-W1A-08): tz misfire prevented by per-ws filter.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import pLimit from 'p-limit';
import { GreetingsService } from './greetings.service';
import {
  CRON_SCHEDULES,
  CRON_TIMEZONES,
  CronJobKey,
} from '../../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { hourBucket } from '../../../../common/scheduler/period-key';

@Injectable()
export class GreetingsCron {
  private readonly logger = new Logger(GreetingsCron.name);

  constructor(
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    private readonly greetings: GreetingsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Party greetings dispatch
   * Execution:   @Cron gated to worker role + Redis single-flight per hour.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (IST registration); per-workspace tz filter fires at
   *              local hour 09:00.
   * Idempotent:  YES - GreetingsService dedupes via a GreetingsDispatchLog unique
   *              index (calendar-day, D-31); a re-run sends nothing new that day.
   * Reads:       workspaces, parties, consent log
   * Writes:      GreetingsDispatchLog; sends greeting messages
   * Missed run:  Self-heals next hour while local hour is still 09; otherwise the
   *              day is skipped (greetings are not retried across days by design).
   * Owner:       finance/party-intelligence
   */
  @Cron(CRON_SCHEDULES.GREETINGS_DISPATCH, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.GREETINGS_DISPATCH,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.GREETINGS_DISPATCH, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const now = new Date();
    const runId = randomUUID();
    const workspaces = await this.workspaceModel
      .find({ isActive: true })
      .select('_id timezone partyIntelligence')
      .lean();

    const limit = pLimit(8);
    await Promise.all(
      workspaces.map((ws: any) =>
        limit(async () => {
          const tz = ws.timezone || 'Asia/Kolkata';
          if (!this.shouldRunInWorkspaceNow(now, tz)) return;
          // Cheap pre-filter: master switch off → skip entirely.
          if (ws?.partyIntelligence?.greetings?.enabled !== true) return;
          try {
            const summary = await this.greetings.runForWorkspace(String(ws._id), runId);
            this.logger.log(
              `Greetings dispatch ws=${ws._id} runId=${runId} ` +
                `sent=${summary.sent} failed=${summary.failed}`,
            );
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? String(err);
            this.logger.warn(`Greetings dispatch failed ws=${ws._id} runId=${runId}: ${msg}`);
          }
        }),
      ),
    );
  }

  /**
   * D-26 — fires at 09:00 local in each workspace's timezone. Exposed so unit
   * tests can stub.
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
    return localHour === 9;
  }
}
