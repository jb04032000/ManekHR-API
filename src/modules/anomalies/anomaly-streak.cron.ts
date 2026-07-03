import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';
import { AnomalyDetectionService, ShiftSnapshot } from './anomaly-detection.service';
import { AnomaliesService } from './anomalies.service';

@Injectable()
export class AnomalyStreakCron {
  private readonly logger = new Logger(AnomalyStreakCron.name);

  constructor(
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
    @InjectModel('Shift') private readonly shiftModel: Model<any>,
    private readonly detectionService: AnomalyDetectionService,
    private readonly anomaliesService: AnomaliesService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Anomaly missed-streak detection
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 00:00 IST - scan each active member for a missed-punch
   *              streak (3+ consecutive working days) and record an anomaly.
   * Idempotent:  YES - AnomaliesService.record dedupes missed_streak by
   *              { wsId, ruleType, contextKey, acknowledged:false }; contextKey is
   *              `${memberId}:${todayIso}`, so a re-run the same day finds the open
   *              anomaly and skips. Tier B (double-run only re-scans, no side effect
   *              beyond the deduped record). Notification dispatch is fire-and-forget.
   * Reads:       workspaces, team_members, shifts, attendance (via detection)
   * Writes:      anomalies (deduped); best-effort anomaly notifications
   * Missed run:  A skipped day is not back-scanned; the next day evaluates its own
   *              window (streaks spanning the gap still surface once it re-runs).
   * Owner:       anomalies
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT_IST, {
    name: CronJobKey.ANOMALY_MISSED_STREAK,
    timeZone: CRON_TIMEZONES.IST,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ANOMALY_MISSED_STREAK, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const startedAt = Date.now();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);

    let workspaceCount = 0;
    let memberCount = 0;
    let anomaliesCreated = 0;

    try {
      const workspaces = await this.workspaceModel.find({}, { _id: 1 }).lean().exec();

      for (const ws of workspaces) {
        workspaceCount++;
        const wsId = String(ws._id);

        let members: Array<{ _id: Types.ObjectId; shiftId: Types.ObjectId }> = [];
        try {
          members = await this.teamMemberModel
            .find(
              {
                workspaceId: new Types.ObjectId(wsId),
                isActive: true,
                isDeleted: { $ne: true },
                shiftId: { $exists: true, $ne: null },
              },
              { _id: 1, shiftId: 1 },
            )
            .lean()
            .exec();
        } catch (err: any) {
          this.logger.warn(
            `[AnomalyStreakCron] Failed to list members for ws=${wsId}: ${err?.message}`,
          );
          continue;
        }

        for (const member of members) {
          memberCount++;
          try {
            const shift = await this.shiftModel
              .findById(member.shiftId, { startTime: 1, endTime: 1, workingDays: 1 })
              .lean<ShiftSnapshot | null>()
              .exec();
            if (!shift || !shift.workingDays?.length) continue;

            const result = await this.detectionService.checkMissedStreak(
              wsId,
              String(member._id),
              shift,
              today,
            );
            if (!result) continue;

            await this.anomaliesService.record({
              wsId,
              ruleType: 'missed_streak',
              severity: 'low',
              teamMemberId: String(member._id),
              context: {
                streakLength: result.streakLength,
                missingDays: result.missingDays,
              },
              contextKey: `${String(member._id)}:${todayIso}`,
            });
            anomaliesCreated++;
          } catch (err: any) {
            this.logger.warn(
              `[AnomalyStreakCron] member=${String(member._id)} ws=${wsId} failed: ${err?.message}`,
            );
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`[AnomalyStreakCron] run aborted: ${err?.message}`);
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `[AnomalyStreakCron] complete — ws=${workspaceCount} members=${memberCount} anomalies=${anomaliesCreated} durationMs=${durationMs}`,
    );
  }
}
