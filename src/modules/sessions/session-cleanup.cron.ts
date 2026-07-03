import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SessionsService } from './sessions.service';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { hourBucket } from '../../common/scheduler/period-key';

@Injectable()
export class SessionCleanupCron {
  private readonly logger = new Logger(SessionCleanupCron.name);

  constructor(
    private sessionsService: SessionsService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Session cleanup + audit-retention sweep
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per hour. See docs/architecture/scheduler-contract.md.
   * Schedule:    hourly (UTC).
   * Steps:       (1) flip expired sessions to isActive:false (JWT-lifetime
   *              cleanup); (2) OQ-4 retention sweep — clear the dead jwtTokenHash
   *              (Bucket C) and stamp `retainUntil` (= now + 1 year) on every
   *              cleared row so the device/IP/userAgent audit fields (Bucket D)
   *              survive the DPDP 1-year traffic-log window, then auto-delete via
   *              the `retainUntil` TTL index (replaces the old 7-day expiresAt TTL).
   * Idempotent:  YES - both steps are time-bounded predicate updates that skip
   *              rows already in the target state (retention guards on the unset
   *              retainUntil), so a second run finds nothing new.
   * Reads:       sessions
   * Writes:      sessions (predicate updates only; no external side effects)
   * Missed run:  Self-heals - the next hourly run clears every still-expired row.
   * Owner:       sessions
   */
  @Cron(CRON_SCHEDULES.EVERY_HOUR, {
    timeZone: CRON_TIMEZONES.UTC,
    name: CronJobKey.SESSION_CLEANUP,
  })
  async handleCron(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.SESSION_CLEANUP, hourBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    this.logger.log('Running session cleanup...');

    try {
      const cleanedCount = await this.sessionsService.cleanupExpiredSessions();
      this.logger.log(`Cleaned up ${cleanedCount} expired sessions`);
      // OQ-4: move cleared sessions into the 1-year audit-retention window
      // (clear the dead token hash, stamp retainUntil for the TTL index).
      const retainedCount = await this.sessionsService.applySessionRetention();
      this.logger.log(`Moved ${retainedCount} sessions into the 1-year audit-retention window`);
    } catch (error) {
      this.logger.error('Session cleanup failed:', error?.message);
    }
  }
}
