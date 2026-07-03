import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import { CRON_TIMEZONES } from '../../../common/constants/cron.constants';
import { env } from '../../../config/env';

/**
 * HARD keep-window floor (RBAC hardening, Pillar 1).
 *
 * The LEGAL/audit MINIMUM window before the per-member access-control overrides
 * are cleared — a CODE CONSTANT, not an env knob. Neither the
 * `RBAC_RETENTION_OVERRIDE_KEEP_YEARS` env value nor a future per-workspace
 * override can drop the window below this; both can only EXTEND the keep window
 * (retain longer), never shorten it. An operator setting
 * RBAC_RETENTION_OVERRIDE_KEEP_YEARS=0 therefore still keeps a 1-year cutoff.
 *
 *   - 1 year — mirrors the ~1y RBAC audit-log retention. After a member leaves,
 *     "what extra/denied access did this person have?" is an audit question best
 *     answered from the override rows for the same window the audit trail keeps
 *     them, then cleared (the rows are basis-less personal access-config after
 *     exit). See docs/compliance/DATA-MAP-AND-RETENTION.md §2 + RBAC spec §2.
 */
export const RBAC_OVERRIDE_KEEP_FLOOR_YEARS = 1;

/**
 * RbacOverrideRetentionCron — RBAC hardening Pillar 1 (owner decision 2026-06-15).
 *
 * The SYSTEM-ONLY cleaner of per-member access-control overrides. Clears
 * `TeamMember.permissionOverrides` + `permissionPathOverrides` (sets both to `[]`)
 * for members who were REMOVED (soft-deleted) longer than the keep window.
 *
 * Owner decision: revoke access NOW, keep the override RECORD ~1 year for audit,
 * then auto-clear. This is NOT the immediate-scrub the Stage-1 spec proposed
 * (migration 0043) — that was SUPERSEDED by the keep-for-audit decision. Access
 * is already revoked at offboard time: a removed member's WorkspaceMember.status
 * flips to 'removed' and the Redis revocation denylist is set, so RolesGuard and
 * CallerScopeService deny BEFORE the override merge can ever run (see the
 * REMOVED-MEMBER SECURITY GUARANTEE comments in both). The leftover override rows
 * are therefore inert from the instant the member leaves; this cron only tidies
 * the now-orphaned config after the audit window lapses.
 *
 * Mirrors the salary / attendance / bills retention purge crons exactly (same
 * OFF-by-default master switch, hard code floor, single-flight, per-workspace
 * loop, updatedAt/deletedAt anchoring philosophy).
 *
 * Safety rails:
 *   - OFF by default (env.rbacRetention.enabled, sharing the master
 *     RUN_RETENTION_PURGE_ON_SCHEDULE switch). With the flag off the cron logs and
 *     exits — prod never auto-clears until the owner explicitly enables it.
 *   - Window = max(env value, HARD floor constant). An env value below the floor
 *     cannot shorten the keep window — both can only extend it.
 *   - ONLY removed members are eligible: `isDeleted: true`. An ACTIVE member's
 *     overrides are NEVER touched, regardless of age.
 *   - Cutoff is anchored on `deletedAt` (the offboard timestamp), so overrides are
 *     cleared 1 year after the member was REMOVED, not after they were created. A
 *     member removed yesterday keeps their override record a full year — fail-safe
 *     (a recent removal is never scrubbed, preserving the restore + audit window).
 *   - SCRUB, not delete: only the two override arrays are zeroed; the TeamMember
 *     row, its identity spine, and statutory fields are untouched (those follow
 *     the Team/Salary/Attendance retention paths). Role DEFINITIONS are never read
 *     or written by this cron.
 *   - Single-flight (Redis) so a multi-worker deploy clears once per day.
 *
 * Note on RBAC audit aging: the `rbac.role_permissions_changed` audit events are
 * written via AuditService.logEvent, which stamps a tier-aware `expiresAt` and a
 * MongoDB TTL index removes them automatically (~365d default). Audit aging is
 * therefore ALREADY handled by the existing AuditService TTL — this cron does NOT
 * (and must not) touch audit rows.
 *
 * Dependency note: reads workspaces; clears two array fields on its own
 * (cross-module-shared) `team_members` collection. No hard-delete; no
 * cross-module write; never touches Role / audit collections.
 */
@Injectable()
export class RbacOverrideRetentionCron {
  private readonly logger = new Logger(RbacOverrideRetentionCron.name);

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(TeamMember.name) private readonly teamMemberModel: Model<TeamMember>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT — RBAC override retention cleaner (RBAC hardening Pillar 1)
   * Execution:   @Cron + Redis single-flight per day. Disabled unless
   *              RUN_RETENTION_PURGE_ON_SCHEDULE=true.
   * Schedule:    daily 04:15 UTC (clear of the salary purge 03:30, attendance
   *              purge 03:45, and bills purge 04:00).
   * Idempotent:  YES — clears only rows still carrying overrides past the window;
   *              a second run finds nothing new (the arrays are already []).
   * Reads:       workspaces
   * Writes:      SCRUB of permissionOverrides + permissionPathOverrides (→ []) on
   *              soft-deleted TeamMember rows past the 1y keep floor (Bucket C).
   *              NEVER hard-deletes a row; never touches Role/audit collections.
   * Owner:       rbac
   */
  @Cron('15 4 * * *', { timeZone: CRON_TIMEZONES.UTC })
  async handlePurge(): Promise<void> {
    if (!env.rbacRetention.enabled) {
      this.logger.debug(
        'RBAC override retention cleaner disabled (RUN_RETENTION_PURGE_ON_SCHEDULE != true); skipping.',
      );
      return;
    }
    await this.singleFlight.runExclusive('rbac.override_retention', dayBucket(), () =>
      this.process(),
    );
  }

  private cutoff(years: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d;
  }

  private async process(): Promise<void> {
    this.logger.log('RBAC override retention cleaner starting...');

    // Window = max(env value, HARD floor constant). The HARD floor is the
    // minimum: an env knob set below the floor cannot shorten it.
    const keepYears = Math.max(env.rbacRetention.overrideKeepYears, RBAC_OVERRIDE_KEEP_FLOOR_YEARS);
    const cutoff = this.cutoff(keepYears);

    const workspaces = await this.workspaceModel.find({}).select('_id name').lean().exec();

    let totalCleared = 0;

    for (const ws of workspaces) {
      const workspaceId = String(ws._id);
      try {
        const wsOid = new Types.ObjectId(workspaceId);

        // Bucket C — per-member access-control overrides on a member REMOVED past
        // the keep window. ONLY isDeleted:true rows whose deletedAt is older than
        // the window AND that still carry at least one override are cleared. An
        // active member is never matched (isDeleted:true gate), an already-cleared
        // member is skipped (the $or non-empty filter → idempotent), and the
        // TeamMember row itself is retained (we $set arrays to [], never delete).
        const res = await this.teamMemberModel.updateMany(
          {
            workspaceId: wsOid,
            isDeleted: true,
            deletedAt: { $lt: cutoff },
            $or: [
              { permissionOverrides: { $exists: true, $not: { $size: 0 } } },
              { permissionPathOverrides: { $exists: true, $not: { $size: 0 } } },
            ],
          },
          { $set: { permissionOverrides: [], permissionPathOverrides: [] } },
        );

        const cleared = res.modifiedCount ?? 0;
        if (cleared > 0) {
          totalCleared += cleared;
          this.logger.log(
            `RBAC override retention ws="${ws.name ?? workspaceId}" cleared=${cleared} ` +
              `(keepYears=${keepYears})`,
          );
        }
      } catch (err) {
        this.logger.error(
          `RBAC override retention cleaner failed for workspace ${workspaceId}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    this.logger.log(
      `RBAC override retention cleaner complete. Total members cleared=${totalCleared}.`,
    );
  }
}
