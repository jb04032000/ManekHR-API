import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { User } from '../users/schemas/user.schema';
import { AccountErasureService } from '../auth/services/account-erasure.service';
import { AuditService } from '../audit/audit.service';
// Connect product removed from ManekHR (2026-07-04). Structural stand-in type
// for the optional purge hook; never provided, so the null-guarded branches
// ('if (!this.connectPurge)') take the skip path.
interface ConnectContentPurgeService {
  purgeUserConnectContent(userId: string): Promise<unknown>;
}
import { ProcessorErasureService } from './processor-erasure.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * Account-deletion Phase 2 — the targeted Day-30 finalize
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3C purge phase, §6/§8).
 *
 * Drives a scheduled whole-account deletion from `pending` to permanently
 * `purged` once its 30-day recovery window has elapsed. This is the personal-data
 * guarantee: it runs as a TARGETED per-account finalize on its own daily cron,
 * REGARDLESS of the OFF-by-default bulk `RUN_RETENTION_PURGE_ON_SCHEDULE` switch
 * (that switch only gates the statutory de-identified purge, §8). So "your
 * personal data is permanently removed after 30 days" is always true.
 *
 * It reuses the existing admin-grade {@link AccountErasureService.eraseAccount}
 * (anonymize-don't-delete: scrub Bucket C + identity, RETAIN billing/statutory +
 * audit, revoke sessions, emit ACCOUNT_ERASED) as the single erasure chokepoint
 * — it does not re-implement any scrub. The sole-admin guard is re-asserted at
 * purge by eraseAccount INTERNALLY under the global ADMIN_ROSTER_LOCK, so this
 * service does NOT take that lock (re-acquiring it would deadlock); it only
 * catches the resulting block and keeps such an account recoverable + alerts ops.
 *
 * SCOPE (Phase 2): identity finalize only. Two seams are intentionally left for
 * later phases and documented in {@link finalizeOne}: the Connect content purge
 * (Phase 3, runs BEFORE the identity scrub) and the processor cascade (Phase 7
 * go-live gate, runs after).
 */
@Injectable()
export class AccountDeletionFinalizeService {
  private readonly logger = new Logger(AccountDeletionFinalizeService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly accountErasure: AccountErasureService,
    private readonly auditService: AuditService,
    // Phase 3 — the Connect content purge (manifest-driven). @Optional so the
    // Phase-2 positional unit tests (3 args) keep compiling; in the running app
    // DI supplies it (AccountDeletionModule imports ConnectAccountPurgeModule).
    @Optional() private readonly connectPurge?: ConnectContentPurgeService,
    // Phase 7 — the processor cascade (DPDP s.8(7): erase at the vendor).
    // @Optional for the same positional-test reason; supplied by DI in the app
    // (AccountDeletionModule provides it + imports UploadsModule).
    @Optional() private readonly processorErasure?: ProcessorErasureService,
  ) {}

  /**
   * Sweep every account whose deletion grace has elapsed and finalize each.
   * Per-account fault isolation: one account's failure never aborts the sweep
   * (it is left pending for the next run). Returns a summary for the cron log.
   */
  async finalizeDuePending(): Promise<{
    scanned: number;
    purged: number;
    blocked: number;
    failed: number;
  }> {
    const now = new Date();
    // ONLY pending accounts whose purgeAfter has elapsed. A 'purged' marker is
    // never reselected (idempotent); a future-dated purgeAfter is skipped.
    const due = await this.userModel
      .find({ 'accountDeletion.state': 'pending', 'accountDeletion.purgeAfter': { $lte: now } })
      .select('_id')
      .lean()
      .exec();

    let purged = 0;
    let blocked = 0;
    let failed = 0;
    for (const u of due as Array<{ _id: Types.ObjectId }>) {
      const outcome = await this.finalizeOne(u._id.toString());
      if (outcome === 'purged') purged++;
      else if (outcome === 'blocked') blocked++;
      else failed++;
    }

    if (due.length > 0) {
      this.logger.log(
        `[finalizeDuePending] scanned ${due.length}, purged ${purged}, blocked ${blocked}, failed ${failed}.`,
      );
    }
    return { scanned: due.length, purged, blocked, failed };
  }

  /**
   * Finalize one account: erase (anonymize) → advance marker `pending`→`purged`
   * → audit `account_deletion_purged`.
   *
   * @returns `'purged'` on success; `'blocked'` if the account is the last active
   *   admin (kept recoverable, no marker change, ops alerted); `'failed'` for any
   *   other error (left pending so the next run retries).
   */
  async finalizeOne(userId: string): Promise<'purged' | 'blocked' | 'failed'> {
    // SEAM (Phase 3): the Connect content purge (manifest-driven) runs HERE,
    // BEFORE the identity scrub, so its by-user queries still see the live
    // identity (plan §3C "Order: Connect purge before the identity scrub").
    // Best-effort (plan §8: a downstream failure never aborts the scrub) — a
    // per-collection failure is recorded in the summary + Sentry'd, and the
    // identity scrub (the core DPDP guarantee) proceeds regardless. The
    // anonymized stub then resolves any residual FK to "Deleted user".
    await this.runConnectPurgeBestEffort(userId);

    // Phase 7 processor cascade — capture the vendor-side artifacts NOW, before
    // the scrub nulls them (the scrub clears `User.profilePicture` but cannot
    // reach the uploaded OBJECT in storage). The cascade itself runs AFTER the
    // scrub commits (below), per plan §8.
    const processorArtifacts = await this.captureProcessorArtifacts(userId);

    try {
      // Reuse the erasure chokepoint. eraseAccount re-asserts the sole-admin
      // guard under the ADMIN_ROSTER_LOCK internally for an admin target
      // (plan §A.4), so we must NOT take that lock here. allowSelf + actor=self
      // because the grace has elapsed and this is the user's OWN scheduled
      // deletion — the admin endpoint keeps ERASURE_SELF_BLOCKED (§A.5).
      await this.accountErasure.eraseAccount(userId, userId, 'DPDP self-serve, grace elapsed', {
        allowSelf: true,
        initiatedBy: 'self-serve',
      });
    } catch (err) {
      if (this.extractCode(err) === 'ERASURE_LAST_ADMIN_BLOCKED') {
        // Keep the account recoverable (do NOT advance the marker) and page ops:
        // a sole admin's deletion reached purge with no other admin present. The
        // schedule-time guard normally prevents this, so reaching it is an
        // operational anomaly, not a routine outcome.
        this.logger.error(
          `[finalizeOne] ${userId} blocked at purge (last active admin) — kept recoverable, alerting ops.`,
        );
        Sentry.captureException(
          err instanceof Error ? err : new Error('ERASURE_LAST_ADMIN_BLOCKED at finalize'),
          {
            tags: { module: 'account-deletion', op: 'finalize.lastAdminBlocked' },
            extra: { userId },
          },
        );
        return 'blocked';
      }
      // Any other failure: leave the account pending so the next sweep retries.
      this.logger.error(
        `[finalizeOne] erase failed for ${userId} (left pending for retry): ${err instanceof Error ? err.message : err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'finalize.erase' },
        extra: { userId },
      });
      return 'failed';
    }

    // Erase committed → run the processor cascade (DPDP s.8(7): erase at the
    // vendor). Best-effort, AFTER the scrub: a vendor failure is recorded but
    // never un-does the committed scrub (plan §8).
    await this.runProcessorCascadeBestEffort(userId, processorArtifacts);

    // Erase committed (identity scrubbed, deletedAt set by eraseAccount). Advance
    // the marker to 'purged' so the sweep never reselects it and the anonymized
    // stub records that it was finalized via self-serve deletion.
    try {
      await this.userModel
        .updateOne(
          { _id: new Types.ObjectId(userId) },
          { $set: { 'accountDeletion.state': 'purged' } },
        )
        .exec();
    } catch (err) {
      // The scrub (the DPDP obligation) already committed; a marker-flip failure
      // is non-fatal — the next run re-erases idempotently then re-flips.
      this.logger.warn(
        `[finalizeOne] marker flip failed for ${userId} (scrub already done): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'account_deletion_purged',
        actorId: userId,
        meta: { scope: 'account', initiatedBy: 'self-serve' },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[finalizeOne] purge audit failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    this.logger.log(
      `[finalizeOne] ${userId} purged (identity anonymized; billing/statutory retained).`,
    );
    return 'purged';
  }

  /**
   * Admin-initiated COMPLETE erase of a user's data (NOT the self-serve Day-30
   * path). Runs the same data-handling as {@link finalizeOne} — Connect content
   * purge BEFORE the identity scrub, processor cascade (vendor file delete) AFTER
   * — but with the calling ADMIN as the actor (no self-serve marker, no
   * allowSelf). eraseAccount's guards (last-active-admin, self-block) propagate to
   * the admin so the UI can surface them; the best-effort steps (Connect purge +
   * processor cascade) never abort the erase.
   *
   * Wired into POST /admin/users/:id/erase — the proper, complete admin erase that
   * replaces the legacy orphan-leaving permanent hard-delete (admin.service
   * deleteUser(permanent), which left salary/attendance/Connect/files behind).
   */
  async eraseUserCompletely(userId: string, actorId: string, reason?: string): Promise<void> {
    // Order matches finalizeOne: purge Connect content while identity is still
    // live, capture vendor artifacts before the scrub nulls them, scrub identity
    // (admin actor), then erase those artifacts at the vendor.
    await this.runConnectPurgeBestEffort(userId);
    const artifacts = await this.captureProcessorArtifacts(userId);
    await this.accountErasure.eraseAccount(userId, actorId, reason);
    await this.runProcessorCascadeBestEffort(userId, artifacts);
  }

  /**
   * Run the Connect content purge for the user, best-effort. Never throws — a
   * Connect-side failure must not abort the Scope-3 identity scrub (plan §8). Any
   * per-collection failures are already logged + Sentry'd inside the purge
   * service and surfaced here at WARN for the finalize log.
   */
  private async runConnectPurgeBestEffort(userId: string): Promise<void> {
    if (!this.connectPurge) return;
    try {
      const summary = await this.connectPurge.purgeUserConnectContent(userId);
      if (summary.failures.length > 0) {
        this.logger.warn(
          `[finalizeOne] Connect purge for ${userId} had ${summary.failures.length} collection failure(s) (continuing to identity scrub): ${summary.failures
            .map((f) => f.collection)
            .join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[finalizeOne] Connect purge threw for ${userId} (continuing to identity scrub): ${err instanceof Error ? err.message : err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'finalize.connectPurge' },
        extra: { userId },
      });
    }
  }

  /**
   * Read the vendor-side artifacts the processor cascade needs (currently the
   * profile-photo URL) BEFORE the scrub nulls them. Best-effort: a read failure
   * degrades to no artifacts (the cascade then deletes nothing) rather than
   * aborting the finalize.
   */
  private async captureProcessorArtifacts(
    userId: string,
  ): Promise<{ profilePicture?: string | null }> {
    try {
      const u = await this.userModel.findById(userId).select('profilePicture').lean().exec();
      return {
        profilePicture: (u as { profilePicture?: string | null } | null)?.profilePicture ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `[finalizeOne] processor-artifact capture failed for ${userId} (cascade will skip): ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return {};
    }
  }

  /**
   * Run the Phase 7 processor cascade (DPDP s.8(7): erase at the vendor),
   * best-effort. Never throws — the scrub has already committed, so a vendor
   * failure is recorded but must not change the finalize outcome (plan §8).
   * No-ops when the cascade service is not wired (positional unit tests).
   */
  private async runProcessorCascadeBestEffort(
    userId: string,
    artifacts: { profilePicture?: string | null },
  ): Promise<void> {
    if (!this.processorErasure) return;
    try {
      await this.processorErasure.eraseAtProcessors(userId, artifacts);
    } catch (err) {
      this.logger.warn(
        `[finalizeOne] processor cascade threw for ${userId} (scrub already committed): ${err instanceof Error ? err.message : 'unknown'}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'finalize.processorCascade' },
        extra: { userId },
      });
    }
  }

  /**
   * Scope-1 Day-30 sweep (plan §3A purge phase): finalize every account whose
   * `connectDeletion.state==='pending'` window has elapsed by running the Connect
   * content purge and advancing the marker `pending`->`purged`. The ERP account
   * is untouched (Connect-only deletion). Per-account fault-isolated.
   */
  async finalizeDueConnectPending(): Promise<{ scanned: number; purged: number; failed: number }> {
    const now = new Date();
    const due = await this.userModel
      .find({ 'connectDeletion.state': 'pending', 'connectDeletion.purgeAfter': { $lte: now } })
      .select('_id')
      .lean()
      .exec();

    let purged = 0;
    let failed = 0;
    for (const u of due as Array<{ _id: Types.ObjectId }>) {
      const outcome = await this.finalizeConnectOne(u._id.toString());
      if (outcome === 'purged') purged++;
      else failed++;
    }

    if (due.length > 0) {
      this.logger.log(
        `[finalizeDueConnectPending] scanned ${due.length}, purged ${purged}, failed ${failed}.`,
      );
    }
    return { scanned: due.length, purged, failed };
  }

  /**
   * Finalize one Scope-1 Connect deletion: run the purge, then advance the marker
   * `pending`->`purged` + audit. If the purge service is unavailable or ANY
   * collection failed, the account is left pending so the next sweep retries (the
   * Connect purge IS the whole operation for Scope 1 — there is no identity scrub
   * to fall back on, so a partial purge must not be marked complete).
   */
  async finalizeConnectOne(userId: string): Promise<'purged' | 'failed'> {
    if (!this.connectPurge) {
      this.logger.error(`[finalizeConnectOne] no purge service available for ${userId}`);
      return 'failed';
    }
    let hadFailures = true;
    try {
      const summary = await this.connectPurge.purgeUserConnectContent(userId);
      hadFailures = summary.failures.length > 0;
      if (hadFailures) {
        this.logger.warn(
          `[finalizeConnectOne] ${userId} left pending — ${summary.failures.length} collection failure(s) will retry.`,
        );
        return 'failed';
      }
    } catch (err) {
      this.logger.error(
        `[finalizeConnectOne] purge threw for ${userId} (left pending for retry): ${err instanceof Error ? err.message : err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'finalizeConnect.purge' },
        extra: { userId },
      });
      return 'failed';
    }

    try {
      await this.userModel
        .updateOne(
          { _id: new Types.ObjectId(userId) },
          { $set: { 'connectDeletion.state': 'purged' } },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `[finalizeConnectOne] marker flip failed for ${userId} (purge already done): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'connect_deletion_purged',
        actorId: userId,
        meta: { scope: 'connect', initiatedBy: 'self-serve' },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[finalizeConnectOne] purge audit failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    this.logger.log(
      `[finalizeConnectOne] ${userId} Connect content purged (ERP account untouched).`,
    );
    return 'purged';
  }

  /** Pull a stable error code from a Nest HttpException response payload. */
  private extractCode(err: unknown): string | undefined {
    const resp = (err as { response?: unknown })?.response;
    if (resp && typeof resp === 'object' && 'code' in resp) {
      return (resp as { code?: string }).code;
    }
    return undefined;
  }
}
