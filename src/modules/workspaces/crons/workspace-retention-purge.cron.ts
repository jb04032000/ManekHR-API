import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workspace } from '../schemas/workspace.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CRON_TIMEZONES } from '../../../common/constants/cron.constants';
import { env } from '../../../config/env';

/**
 * HARD grace-window floor (Workspaces hardening, §3e).
 *
 * The MINIMUM grace before a soft-deleted workspace's Bucket-C profile/config is
 * scrubbed — a CODE CONSTANT, not an env knob. Neither the
 * `WORKSPACE_RETENTION_GRACE_DAYS` env value can drop the window below this; it
 * can only EXTEND the grace (keep the cosmetic config longer). An operator
 * setting WORKSPACE_RETENTION_GRACE_DAYS=0 therefore still keeps a 30-day grace.
 *
 *   - 30 days — matches the OQ-W3 self-serve undo window. A workspace must keep
 *     its branding / preferences intact for at least the restore window so an
 *     "undo delete" inside 30 days restores a fully-configured workspace, not a
 *     scrubbed shell. The data-map §2a "exit + 30-90d grace" lower bound.
 */
export const WORKSPACE_RETENTION_GRACE_FLOOR_DAYS = 30;

/**
 * WorkspaceRetentionPurgeCron — Workspaces hardening Pillar 1 (§3e, AC-1.4).
 *
 * The SYSTEM-ONLY scrub of a soft-deleted workspace's Bucket-C profile/config
 * after a grace window — never a user action. Mirrors the salary / attendance /
 * bills / rbac retention crons exactly (same OFF-by-default master switch, hard
 * code floor, single-flight, per-workspace loop, deletedAt anchoring).
 *
 * WHAT IT SCRUBS (Bucket C — no legal/contractual/audit basis): branding logos,
 * exportPreferences, notificationPolicy, selfServiceConfig, partyIntelligence,
 * autoAcceptKnownInvites, storageUsage, appLockIdleMs, kioskEnabled, and the
 * residual operational SMTP fields (host/port/user/fromEmail/secure/enabled).
 * The CREDENTIALS (kioskTokenHash + kioskAllowedIpRanges + kioskTokenRotatedAt +
 * attendanceIngestToken + emailConfig.smtpConfig.pass) were already nulled
 * IMMEDIATELY at soft-delete time (WorkspacesService.remove) — they are not
 * waited on a grace window because they are live credentials.
 *
 * WHAT IT RETAINS (never touched here): Bucket-A identity spine (name /
 * workspaceCode / businessType / location / address / timezone /
 * fiscalYearStartMonth / ownerId / designations / bankAccounts /
 * employeeCodeSettings / regularizationConfig / attendanceSettings /
 * maintenanceLeadTimeDays / productionUptimeTargetPct / emailConfig usage +
 * limit override) and ALL Bucket-B statutory rows in other collections.
 *
 * WHAT IT DOES NOT DO (deferred, §3e safety valve): it does NOT purge the
 * workspace row itself or its counters. That requires a cross-module "last-B"
 * condition (purge the row only after EVERY per-module retention job has erased
 * its Bucket-B rows for this workspace — salary 8/10y, attendance 10y, finance
 * 8y). Expressing that check safely needs the per-module purge ledgers to land
 * first; doing it blind risks erasing the identity spine while a statutory row
 * still references it. Scoped to the Bucket-C field scrub for now; the row-purge
 * is logged as a follow-up (ISSUES register / DATA-MAP §4b).
 *
 * Safety rails:
 *   - OFF by default (env.workspaceRetention.enabled, sharing the master
 *     RUN_RETENTION_PURGE_ON_SCHEDULE switch). With the flag off the cron logs
 *     and exits — prod never auto-scrubs until the owner explicitly enables it
 *     (AC-1.4).
 *   - Grace = max(env value, HARD floor constant). An env value below the floor
 *     cannot shorten the grace — both can only extend it (keep config longer).
 *   - ONLY soft-deleted rows are eligible: `isDeleted: true`. An active workspace
 *     is NEVER touched, regardless of age.
 *   - Cutoff anchored on `deletedAt` (the soft-delete timestamp), so config is
 *     scrubbed `graceDays` after the workspace was DELETED, not created. A
 *     workspace deleted yesterday keeps a full grace — fail-safe (a restore
 *     inside the OQ-W3 window still finds its branding intact).
 *   - The `$unset`/`$set` filter additionally requires at least one scrub-target
 *     field to still be present, so an already-scrubbed row is skipped (no churn,
 *     accurate `modifiedCount`).
 *   - Single-flight (Redis) so a multi-worker deploy scrubs once per day.
 *
 * Dependency note: reads + writes ONLY the `workspaces` collection (Bucket-C
 * field scrub on soft-deleted rows). No cross-module write; no row delete.
 */
@Injectable()
export class WorkspaceRetentionPurgeCron {
  private readonly logger = new Logger(WorkspaceRetentionPurgeCron.name);

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT — Workspace retention purge (§3e)
   * Execution:   @Cron + Redis single-flight per day. Disabled unless
   *              RUN_RETENTION_PURGE_ON_SCHEDULE=true.
   * Schedule:    daily 04:15 UTC (clear of the salary purge 03:30, attendance
   *              03:45, and bills 04:00).
   * Idempotent:  YES — scrubs only soft-deleted rows past the grace window that
   *              still carry a Bucket-C field; a second run finds nothing new.
   * Reads:       workspaces
   * Writes:      Bucket-C field scrub ($unset/$set) on soft-deleted workspace
   *              rows past the grace floor. NEVER deletes a row or statutory data.
   * Owner:       workspaces
   */
  @Cron('15 4 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handlePurge(): Promise<void> {
    if (!env.workspaceRetention.enabled) {
      this.logger.debug(
        'Workspace retention purge disabled (RUN_RETENTION_PURGE_ON_SCHEDULE != true); skipping.',
      );
      return;
    }
    await this.singleFlight.runExclusive('workspace.retention_purge', dayBucket(), () =>
      this.process(),
    );
  }

  private cutoff(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d;
  }

  private async process(): Promise<void> {
    this.logger.log('Workspace retention purge (Bucket-C scrub) starting...');

    // Grace = max(env value, HARD floor constant). The HARD floor is the minimum:
    // an env knob set below the floor cannot shorten the grace (AC-1.4); both can
    // only extend it so a config-restore inside the undo window still works.
    const graceDays = Math.max(
      env.workspaceRetention.graceDays,
      WORKSPACE_RETENTION_GRACE_FLOOR_DAYS,
    );
    const cutoff = this.cutoff(graceDays);

    // Bucket-C fields to clear. Defaults that the schema would re-apply are set to
    // their default; pure preference/config fields are $unset. Identity (Bucket A)
    // and statutory (Bucket B, other collections) are intentionally absent.
    const $unset: Record<string, ''> = {
      branding: '',
      exportPreferences: '',
      notificationPolicy: '',
      selfServiceConfig: '',
      partyIntelligence: '',
      storageUsage: '',
      appLockIdleMs: '',
      // Residual operational SMTP fields (the credential `pass` was already nulled
      // at delete time; these host/port/user/fromEmail values are basis-less now).
      'emailConfig.smtpConfig.host': '',
      'emailConfig.smtpConfig.port': '',
      'emailConfig.smtpConfig.user': '',
      'emailConfig.smtpConfig.fromEmail': '',
      'emailConfig.smtpConfig.fromName': '',
    };
    const $set: Record<string, unknown> = {
      autoAcceptKnownInvites: false,
      kioskEnabled: false,
      'emailConfig.smtpConfig.enabled': false,
    };

    // Only target rows that STILL carry at least one Bucket-C field, so an already
    // -scrubbed row is skipped and `modifiedCount` reflects real work.
    const filter = {
      isDeleted: true,
      deletedAt: { $lt: cutoff },
      $or: [
        { branding: { $exists: true } },
        { exportPreferences: { $exists: true } },
        { notificationPolicy: { $exists: true } },
        { selfServiceConfig: { $exists: true } },
        { partyIntelligence: { $exists: true } },
        { storageUsage: { $exists: true } },
        { appLockIdleMs: { $ne: null } },
        { autoAcceptKnownInvites: true },
        { kioskEnabled: true },
        { 'emailConfig.smtpConfig.host': { $exists: true } },
      ],
    };

    try {
      const res = await this.workspaceModel.updateMany(filter, { $unset, $set });
      const scrubbed = res.modifiedCount ?? 0;
      this.logger.log(
        `Workspace retention purge complete. Bucket-C scrubbed on ${scrubbed} soft-deleted ` +
          `workspace(s) (graceDays=${graceDays}). Row-purge (last-B condition) deferred.`,
      );
    } catch (err) {
      this.logger.error(`Workspace retention purge failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
