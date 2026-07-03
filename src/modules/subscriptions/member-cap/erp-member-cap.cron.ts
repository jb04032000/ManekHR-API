import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CronJobKey, CRON_SCHEDULES } from '../../../common/constants/cron.constants';
import { ErpMemberCapService } from './erp-member-cap.service';

/**
 * ErpMemberCapReconcileCron — nightly grace-clock + over-cap notice reconcile.
 *
 * The allowed-member set is computed at READ time (never stored), so this cron
 * writes NO cap flag. Its only job is to start/clear the per-workspace grace
 * clock and fire the once-per-episode over-cap notice for workspaces whose owner
 * never opens a capped report (active owners get reconciled lazily on the Team
 * list read). Without it, a passive over-cap workspace would never start its
 * fair-warning clock or get the notice.
 *
 * `tick()` is extracted from `run()` so tests can call it without the @Cron
 * decorator or a Redis lock. Mirrors ConnectOverLimitReconcileCron exactly.
 */
@Injectable()
export class ErpMemberCapReconcileCron {
  private readonly logger = new Logger(ErpMemberCapReconcileCron.name);

  constructor(
    private readonly memberCap: ErpMemberCapService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - ERP member-cap reconcile
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 05:00 UTC - for every candidate workspace, start/clear the
   *              grace clock and fire the once-per-episode over-cap notice.
   * Idempotent:  YES - convergent clock writes (set overCapSince only when null,
   *              clear when back under cap) + the notification is guarded by the
   *              per-episode notifiedAt marker, so a re-run never re-notifies. No
   *              money/content side effect. The cap is read-time, not written.
   * Reads:       team members (counts), workspaces / subscriptions (limits),
   *              erp_member_cap_states
   * Writes:      erp_member_cap_states (grace clock + notice marker only),
   *              notifications (one row per new episode)
   * Missed run:  A skipped day delays a passive workspace's clock-start / notice
   *              by a day; the next run catches them up. No catch-up backlog
   *              (state is convergent, not per-occurrence).
   * Owner:       subscriptions/member-cap
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_5_00_UTC, { name: CronJobKey.ERP_MEMBER_CAP_RECONCILE })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.ERP_MEMBER_CAP_RECONCILE, dayBucket(), () =>
      this.tick(),
    );
  }

  /**
   * Reconcile every candidate workspace. Per-workspace failures are logged +
   * Sentry-captured but never abort the sweep (one bad workspace must not starve
   * the rest). Returns the number of workspaces processed (for tests /
   * observability).
   */
  async tick(): Promise<number> {
    const workspaceIds = await this.memberCap.candidateWorkspaceIds();
    let processed = 0;
    for (const workspaceId of workspaceIds) {
      try {
        await this.memberCap.reconcileWorkspace(workspaceId);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `member-cap reconcile failed for ${workspaceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        Sentry.captureException(err, {
          tags: { module: 'erp.member_cap', op: 'reconcile_cron' },
          extra: { workspaceId },
        });
      }
    }
    this.logger.log(
      `member-cap reconcile: processed ${processed}/${workspaceIds.length} workspaces`,
    );
    return processed;
  }
}
