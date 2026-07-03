import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { Subscription } from '../schemas/subscription.schema';
import { ErpMemberCapState } from './schemas/erp-member-cap-state.schema';
import { NotificationsService } from '../../notifications/notifications.service';
import { computeAllowedMemberIds, graceElapsed, UNLIMITED } from './erp-member-cap.helpers';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Grace window (in days) after a workspace first goes OVER its member limit,
 * during which it sees only a warning and NOTHING is capped. After this window
 * the read-time cap applies. Mirrors the Connect over-limit grace clock; Connect
 * reads its value from plan entitlements (`entitlements.connect.overLimitGraceDays`,
 * default 30). ERP plans carry no member-cap grace field today, so we default to
 * a constant. It is exported + overridable (a future plan-entitlement read can
 * resolve a per-plan value here) rather than hard-coded inline at the call site.
 *
 * Chosen: 7 days. A staff/payroll workspace is far more sensitive than a Connect
 * marketplace listing — a week is enough fair warning to upgrade or trim the
 * roster, but short enough that a lapsed-trial Free workspace can't keep
 * operating 50 staff indefinitely under the warning banner.
 */
export const ERP_MEMBER_CAP_GRACE_DAYS = 7;

/** Computed cap status for a workspace (compute-at-read; nothing persisted). */
export interface ErpMemberCapStatus {
  /** True when the cap is actively applied (over cap AND grace elapsed). */
  capped: boolean;
  /** Number of members visible right now = allowed-set length. */
  visibleCount: number;
  /** Live active member count (the full roster). */
  totalCount: number;
  /** The plan's member limit (-1 = unlimited). */
  limit: number;
  /** True when over cap but still inside the grace window (warning only). */
  inGrace: boolean;
  /** overCapSince + graceDays, or null when not over cap. */
  graceEndsAt: Date | null;
}

/**
 * ERP member-cap — read-time grandfathering of a workspace's roster against its
 * plan's `maxMembersPerWorkspace`. Mirrors the Connect over-limit service:
 *
 * - The ALLOWED member set is COMPUTED at read time, never persisted. A delete /
 *   re-upgrade reverses the cap on the very next read (drift-free).
 * - The only persisted state is `ErpMemberCapState` (the per-workspace grace
 *   clock + once-per-episode notification marker), maintained idempotently by
 *   `reconcileWorkspace`.
 *
 * Allowed set = the workspace OWNER (always) + the OLDEST `(limit - 1)` other
 * members by join date. Owner is NEVER excluded. Unlimited (-1) → everyone.
 *
 * Consumers (Team / Salary / Attendance read paths — Phase 6) inject this and
 * call `getAllowedMemberIds` to scope their queries. This service depends only on
 * the four models + NotificationsService, never on TeamService /
 * SubscriptionsService, so the consumer → service dependency direction stays
 * acyclic.
 */
@Injectable()
export class ErpMemberCapService {
  private readonly logger = new Logger(ErpMemberCapService.name);

  constructor(
    @InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>,
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(ErpMemberCapState.name)
    private readonly stateModel: Model<ErpMemberCapState>,
    private readonly notifications: NotificationsService,
  ) {}

  /** Grace window for a workspace. Constant today; a per-plan override resolves
   *  here if/when ERP plans grow a member-cap grace field. */
  private graceDays(): number {
    return ERP_MEMBER_CAP_GRACE_DAYS;
  }

  /** Mongo filter selecting the LIVE active members of a workspace (the roster
   *  that counts toward the cap). Excludes soft- and permanently-deleted rows. */
  private activeMemberFilter(wid: Types.ObjectId): Record<string, unknown> {
    return {
      workspaceId: wid,
      isActive: true,
      isDeleted: false,
      isPermanentlyDeleted: { $ne: true },
    };
  }

  /**
   * Resolve the owner User's own TeamMember id in this workspace (the member row
   * whose `linkedUserId` is the workspace owner), or null when the owner has no
   * member record. The cap reserves a seat for this id so the owner is never
   * suppressed.
   */
  private async resolveOwnerMemberId(
    wid: Types.ObjectId,
    ownerUserId: Types.ObjectId,
  ): Promise<string | null> {
    const row = await this.teamModel
      .findOne({ ...this.activeMemberFilter(wid), linkedUserId: ownerUserId })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    return row ? String(row._id) : null;
  }

  /**
   * Active OTHER member ids (owner excluded), sorted by join date ASCENDING
   * (oldest first) — `dateOfJoining` then `createdAt` as the tiebreak so members
   * with no recorded join date fall back to insertion order. Used to fill the
   * non-owner seats under the cap.
   */
  private async orderedOtherMemberIds(
    wid: Types.ObjectId,
    ownerMemberId: string | null,
  ): Promise<string[]> {
    const rows = await this.teamModel
      .find(this.activeMemberFilter(wid))
      .select('_id')
      .sort({ dateOfJoining: 1, createdAt: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    const ids = rows.map((r) => String(r._id));
    return ownerMemberId ? ids.filter((id) => id !== ownerMemberId) : ids;
  }

  /**
   * Resolve the workspace's effective member limit from the OWNER's most-recent
   * active/trial subscription `appliedEntitlements.maxMembersPerWorkspace`.
   * Mirrors the SubscriptionGuard owner-pivot + team.service create-path read.
   * Falls back to the Free default (5) when no subscription / no entitlement
   * exists, matching team.service's `defaultPerWorkspaceLimit`.
   */
  private async resolveLimit(ownerUserId: Types.ObjectId): Promise<number> {
    const DEFAULT_FREE_LIMIT = 5;
    const sub = await this.subscriptionModel
      .findOne({ userId: ownerUserId, status: { $in: ['active', 'trial'] } })
      .select('appliedEntitlements')
      .sort({ createdAt: -1 })
      .lean<{ appliedEntitlements?: { maxMembersPerWorkspace?: number } } | null>()
      .exec();
    const limit = sub?.appliedEntitlements?.maxMembersPerWorkspace;
    return typeof limit === 'number' ? limit : DEFAULT_FREE_LIMIT;
  }

  /** Load the workspace's owner User id, or null when the workspace is missing. */
  private async resolveOwnerUserId(wid: Types.ObjectId): Promise<Types.ObjectId | null> {
    const ws = await this.workspaceModel
      .findById(wid)
      .select('ownerId')
      .lean<{ ownerId: Types.ObjectId } | null>()
      .exec();
    return ws ? new Types.ObjectId(String(ws.ownerId)) : null;
  }

  /**
   * READ-TIME allowed member-id set for a workspace. Never writes state.
   *
   * Returns ALL active member ids (no cap) under any of: unlimited limit, not
   * over cap, no grace clock started yet, or still within grace — so injecting
   * this into a read path is a behavior-preserving pass-through until the cap
   * actually applies. Only after grace + over cap does it return the
   * owner-first / oldest-survive allowed subset.
   */
  async getAllowedMemberIds(workspaceId: string, now: Date = new Date()): Promise<string[]> {
    const wid = new Types.ObjectId(workspaceId);

    const ownerUserId = await this.resolveOwnerUserId(wid);
    // No workspace / owner → nothing to scope; return the live roster as-is.
    if (!ownerUserId) return this.allActiveMemberIds(wid);

    const limit = await this.resolveLimit(ownerUserId);

    // Unlimited → no cap, everyone.
    if (limit === UNLIMITED) return this.allActiveMemberIds(wid);

    const ownerMemberId = await this.resolveOwnerMemberId(wid, ownerUserId);
    const others = await this.orderedOtherMemberIds(wid, ownerMemberId);
    const totalCount = others.length + (ownerMemberId ? 1 : 0);

    // Not over the limit → everyone (no cap).
    if (totalCount <= limit) {
      return ownerMemberId ? [ownerMemberId, ...others] : others;
    }

    // Over the limit, but the cap only bites after the grace window AND only when
    // the clock has actually been started (fair warning first).
    const state = await this.stateModel.findOne({ workspaceId: wid }).lean().exec();
    if (!state?.overCapSince || !graceElapsed(state.overCapSince, this.graceDays(), now)) {
      return ownerMemberId ? [ownerMemberId, ...others] : others;
    }

    // After grace + over cap → the allowed subset.
    return computeAllowedMemberIds(ownerMemberId, others, limit);
  }

  /** All live active member ids of a workspace (the full uncapped roster). */
  private async allActiveMemberIds(wid: Types.ObjectId): Promise<string[]> {
    const rows = await this.teamModel
      .find(this.activeMemberFilter(wid))
      .select('_id')
      .sort({ dateOfJoining: 1, createdAt: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return rows.map((r) => String(r._id));
  }

  /**
   * Computed cap status for the capped-report notice (Phase 6/7 consume this).
   * Compute-at-read; persists nothing. `visibleCount` = allowed-set length,
   * `totalCount` = live active member count.
   */
  async getCapStatus(workspaceId: string, now: Date = new Date()): Promise<ErpMemberCapStatus> {
    const wid = new Types.ObjectId(workspaceId);
    const ownerUserId = await this.resolveOwnerUserId(wid);

    const totalCount = await this.teamModel.countDocuments(this.activeMemberFilter(wid)).exec();

    if (!ownerUserId) {
      return {
        capped: false,
        visibleCount: totalCount,
        totalCount,
        limit: UNLIMITED,
        inGrace: false,
        graceEndsAt: null,
      };
    }

    const limit = await this.resolveLimit(ownerUserId);
    const overCap = limit !== UNLIMITED && totalCount > limit;

    const state = overCap
      ? await this.stateModel.findOne({ workspaceId: wid }).lean().exec()
      : null;
    const overCapSince = state?.overCapSince ?? null;
    const graceEnds = overCapSince
      ? new Date(overCapSince.getTime() + this.graceDays() * MS_PER_DAY)
      : null;
    const elapsed = graceElapsed(overCapSince, this.graceDays(), now);
    const capped = overCap && elapsed;
    const inGrace = overCap && !!overCapSince && !elapsed;

    const allowed = await this.getAllowedMemberIds(workspaceId, now);

    return {
      capped,
      visibleCount: allowed.length,
      totalCount,
      limit,
      inGrace,
      graceEndsAt: graceEnds,
    };
  }

  /**
   * Candidate workspace ids for the nightly reconcile cron. Returns the UNION of:
   *  - every workspace that already has a member-cap state row (an open or
   *    just-ended episode whose clock/notice the cron must advance or clear), and
   *  - every live (non-deleted) workspace (so a workspace that has only just gone
   *    over cap — and therefore has no state row yet — still gets its grace clock
   *    started without waiting for someone to open a capped report).
   *
   * `reconcileWorkspace` is idempotent + cheap (a count + at most one state read/
   * write), so reconciling the full live set nightly is safe; this mirrors the
   * Connect over-limit cron's `distinctOwnerIds` enumeration. The state-row ids
   * are folded in so a workspace that was deleted while an episode was open still
   * gets its stale episode cleared.
   */
  async candidateWorkspaceIds(): Promise<string[]> {
    const [liveWorkspaceIds, stateWorkspaceIds] = await Promise.all([
      this.workspaceModel.distinct('_id', { isDeleted: { $ne: true } }).exec(),
      this.stateModel.distinct('workspaceId').exec(),
    ]);
    const set = new Set<string>();
    for (const arr of [liveWorkspaceIds, stateWorkspaceIds]) {
      for (const id of arr) if (id) set.add(String(id));
    }
    return Array.from(set);
  }

  /**
   * Converge the persisted episode state for a workspace. Sets `overCapSince` on
   * the first over-cap observation (starting the grace clock), fires the
   * once-per-episode notice once grace has elapsed, and clears the whole episode
   * when back under cap. Idempotent: a re-run with the same live state changes
   * nothing and never re-notifies.
   */
  async reconcileWorkspace(workspaceId: string, now: Date = new Date()): Promise<void> {
    const wid = new Types.ObjectId(workspaceId);
    const ownerUserId = await this.resolveOwnerUserId(wid);
    if (!ownerUserId) return;

    const limit = await this.resolveLimit(ownerUserId);
    const totalCount = await this.teamModel.countDocuments(this.activeMemberFilter(wid)).exec();
    const overCap = limit !== UNLIMITED && totalCount > limit;

    const state = await this.reconcileState(wid, overCap, now);
    const overCapSince = state?.overCapSince ?? null;

    // Fire the entry notice once per episode — but only after the grace window
    // has elapsed (fair-warning model: warn first, then notify when the cap
    // actually starts to bite). Guarded by `notifiedAt`.
    if (
      overCap &&
      overCapSince &&
      !state?.notifiedAt &&
      graceElapsed(overCapSince, this.graceDays(), now)
    ) {
      await this.notifyEntry(workspaceId, ownerUserId, totalCount, limit);
      await this.stateModel.updateOne({ workspaceId: wid }, { $set: { notifiedAt: now } }).exec();
    }
  }

  /**
   * Convergent upsert of the per-workspace episode state. Starts `overCapSince`
   * on entry (preserving an existing clock), clears the whole episode when back
   * under cap. Atomic upsert so a lazy reconcile and a worker cron never race to
   * create duplicates.
   */
  private async reconcileState(
    wid: Types.ObjectId,
    overCap: boolean,
    now: Date,
  ): Promise<ErpMemberCapState | null> {
    if (overCap) {
      // Start the clock only if not already running (preserve the episode start).
      await this.stateModel
        .updateOne(
          { workspaceId: wid },
          { $setOnInsert: { workspaceId: wid, overCapSince: now, notifiedAt: null } },
          { upsert: true },
        )
        .exec();
      // If the row pre-existed with a null clock (episode ended then re-entered),
      // re-arm it: set the start fresh and clear the prior notice so we re-notify.
      await this.stateModel
        .updateOne(
          { workspaceId: wid, overCapSince: null },
          { $set: { overCapSince: now, notifiedAt: null } },
        )
        .exec();
      return this.stateModel.findOne({ workspaceId: wid }).exec();
    }
    // Under cap → end the episode (clear the clock + notice) if one was open.
    await this.stateModel
      .updateOne(
        { workspaceId: wid, overCapSince: { $ne: null } },
        { $set: { overCapSince: null, notifiedAt: null } },
      )
      .exec();
    return this.stateModel.findOne({ workspaceId: wid }).exec();
  }

  /** Dispatch the one-time over-cap notice for the current episode. */
  private async notifyEntry(
    workspaceId: string,
    ownerUserId: Types.ObjectId,
    used: number,
    limit: number,
  ): Promise<void> {
    const title = `Your workspace is over its member limit`;
    const message =
      `Your workspace has ${used} of ${limit} members — only the oldest ${limit} ` +
      `(including you) are shown in reports until you upgrade. Nothing is deleted.`;
    try {
      await this.notifications.dispatch({
        recipientId: String(ownerUserId),
        category: 'erp.member_cap',
        title,
        message,
        type: 'warning',
        entityType: 'erp_member_cap',
        entityId: workspaceId,
        workspaceId,
        metadata: { used, limit },
      });
    } catch (err) {
      // Never let a notification failure break the reconcile.
      this.logger.error(
        `member-cap notify failed for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      Sentry.captureException(err, { tags: { module: 'erp.member_cap', op: 'notify' } });
    }
  }
}
