import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CronJobKey, CRON_SCHEDULES } from '../../../common/constants/cron.constants';
import { ConnectOverLimitService } from './connect-over-limit.service';

/**
 * ConnectOverLimitReconcileCron — nightly grace-clock + entry-notice reconcile.
 *
 * Suppression is computed at read time (never stored), so this cron writes NO
 * suppression flag. Its only job is to start/clear the per-(user,kind) grace
 * clock and fire the once-per-episode over-limit notice for PASSIVE users who
 * never open GET /me/connect/usage (active users get reconciled lazily on that
 * read). Without it, a passive over-limit user would never start their fair-
 * warning clock or get the notice.
 *
 * `tick()` is extracted from `run()` so tests can call it without the @Cron
 * decorator or a Redis lock.
 */
@Injectable()
export class ConnectOverLimitReconcileCron {
  private readonly logger = new Logger(ConnectOverLimitReconcileCron.name);

  constructor(
    private readonly overLimit: ConnectOverLimitService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Connect over-limit reconcile
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 04:45 UTC - for every owner of a Connect item, start/clear
   *              the grace clock and fire the once-per-episode over-limit notice.
   * Idempotent:  YES - convergent clock writes (set overLimitSince only when null,
   *              clear when back under limit) + the notification is guarded by the
   *              per-episode notifiedAt marker, so a re-run never re-notifies. No
   *              money/content side effect. Suppression is read-time, not written.
   * Reads:       connect listings / storefronts / company_pages / jobs (counts),
   *              subscriptions / plans (allowances), connect_over_limit_states
   * Writes:      connect_over_limit_states (grace clock + notice marker only),
   *              notifications (one row per new episode)
   * Missed run:  A skipped day delays a passive user's clock-start / notice by a
   *              day; the next run catches them up. No catch-up backlog (state is
   *              convergent, not per-occurrence).
   * Owner:       connect/monetization
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_4_45_UTC, { name: CronJobKey.CONNECT_OVER_LIMIT_RECONCILE })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.CONNECT_OVER_LIMIT_RECONCILE, dayBucket(), () =>
      this.tick(),
    );
  }

  /**
   * Reconcile every distinct Connect-item owner. Per-owner failures are logged +
   * Sentry-captured but never abort the sweep (one bad owner must not starve the
   * rest). Returns the number of owners processed (for tests / observability).
   */
  async tick(): Promise<number> {
    const owners = await this.overLimit.distinctOwnerIds();
    let processed = 0;
    for (const userId of owners) {
      try {
        await this.overLimit.reconcileUser(userId);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `over-limit reconcile failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'connect.over_limit', op: 'reconcile_cron' },
          extra: { userId },
        });
      }
    }
    this.logger.log(`over-limit reconcile: processed ${processed}/${owners.length} owners`);
    return processed;
  }
}
