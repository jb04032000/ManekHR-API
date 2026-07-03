import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { ACCOUNT_ERASED, type AccountErasedEvent } from '../events/account-erasure.events';
import { User } from '../../users/schemas/user.schema';
import { SessionsService } from '../../sessions/sessions.service';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { UserClaimsCacheService } from '../../users/user-claims-cache.service';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
// Workspaces hardening OQ-W4 (approved Option B) — erasure auto-soft-deletes the
// user's owned workspaces so none is left orphaned (owner FK → "Deleted user").
// WorkspacesModule is @Global; injected @Optional() so the existing 5-arg unit
// tests (which construct this service directly) keep compiling and so a missing
// provider degrades gracefully rather than breaking erasure.
import { WorkspacesService } from '../../workspaces/workspaces.service';

/**
 * Global "admin roster" mutex key (AUTH-H4a). Serializes the last-admin check +
 * scrub of any ADMIN target across the whole platform, so the count is always
 * accurate at decision time and two concurrent erasures can never each read
 * "one other admin remains" before either writes. Not workspace-scoped — the
 * `isAdmin` flag is a platform-wide privilege, so the invariant is platform-wide.
 */
const ADMIN_ROSTER_LOCK = 'auth:admin-roster';

/**
 * Account-level erasure (OQ-3 / DPDP data-principal erasure right).
 *
 * Triggered ONLY by an admin/staff action (no public self-serve UI this pass).
 * It is the Auth-layer half of the deletion model in DATA-MAP-AND-RETENTION.md
 * and auth-hardening-spec §3: anonymize-don't-delete.
 *
 * WHAT IT ERASES (Bucket C — no legal/contractual/audit basis):
 *   - ALL auth secrets: passwordHash, pinHash, googleId, every email/mobile
 *     verification + reset token/state, login-token hashes (via session
 *     revocation), device binding (fcmToken), and basis-less preferences
 *     (appLockIdleMs, dismissedHints, sessionLimitOverride, connectEnabled,
 *     isAdmin).
 *   - Identity PII WITHOUT a retention basis: name -> "Deleted user" stub,
 *     email/mobile -> null (sparse unique indexes make null safe), profile
 *     picture, handle -> "user-<id>".
 *
 * WHAT IT RETAINS (explicit owner instruction):
 *   - Statutory / contractual records — salary/payroll, attendance, and
 *     billing/GST — are NOT touched. They live in their OWN collections
 *     (Salary, Attendance, Finance, plus User.razorpayCustomerId +
 *     User.billingProfile which are Bucket B). This service leaves every
 *     foreign key intact and keeps the now-anonymized User stub linked, so
 *     those statutory rows stay meaningful and legally complete. We DO keep
 *     razorpayCustomerId + billingProfile (Bucket B, 8-year basis) and the
 *     Bucket D audit stamps (deactivatedAt / policy-accepted timestamps).
 *
 * WHAT IT DOES NOT DO (by design):
 *   - It does NOT run the `memberHasHistory` check — that gate lives in the
 *     Team module (the only place workspace-scoped member removal is
 *     triggered). This path coordinates with the existing offboarding cascade
 *     rather than re-implementing it: it revokes account-level sessions and
 *     scrubs Auth/identity, leaving workspace membership + statutory data to
 *     the Team/Salary/Attendance modules' own retention jobs.
 *   - It does NOT hard-delete the User row or any statutory row.
 *
 * SAFETY GUARDS (AUTH-H4): erasure is blocked for self-erase (target == actor)
 * and for the last remaining active admin (no other active, non-deleted admin
 * would remain), so an admin cannot orphan platform admin access. Both raise a
 * 409 ConflictException with a stable code (ERASURE_SELF_BLOCKED /
 * ERASURE_LAST_ADMIN_BLOCKED).
 *
 * Dependency note: reads/writes the `users` collection; calls
 * SessionsService.invalidateAllSessions (denylist + deactivate every session
 * row, cross-workspace); invalidates the JWT claims cache (OQ-2); audits via
 * AuditService as an `auth_event`. Affects: any module that resolves a user by
 * id will now see the "Deleted user" stub (intended). Statutory modules are
 * unaffected (FKs preserved).
 */
@Injectable()
export class AccountErasureService {
  private readonly logger = new Logger(AccountErasureService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly sessionsService: SessionsService,
    private readonly auditService: AuditService,
    private readonly userClaimsCache: UserClaimsCacheService,
    // AUTH-H4a: the same Redis lock utility the migration runner uses, here as a
    // BLOCKING mutex (`withLock`) to serialize the last-admin check + scrub.
    private readonly singleFlight: SingleFlightService,
    // OQ-3: emits ACCOUNT_ERASED so the Connect profile module hides + de-indexes
    // the erased user from public Connect surfaces / search, WITHOUT auth taking
    // a dependency on Connect (decoupled via the global event bus). @Optional so
    // the existing direct-construction unit tests still compile.
    @Optional() private readonly eventEmitter?: EventEmitter2,
    // OQ-W4 — optional so existing direct-construction unit tests (5 args) still
    // compile; in the running app DI supplies the @Global WorkspacesService.
    @Optional() private readonly workspacesService?: WorkspacesService,
  ) {}

  /**
   * Build the Bucket-C scrub patch for a User — the single source of truth for
   * "what gets nulled on erasure". Exported as a pure function (no IO) so the
   * grace-window scrub cron and the immediate-erasure path apply the EXACT same
   * field set, and so tests can assert the full list. Every entry maps to a
   * Bucket-C field in auth-hardening-spec §2a (no retention basis).
   */
  static buildBucketCScrubPatch(userIdHex: string): Record<string, unknown> {
    return {
      // ── Identity PII with no retention basis (anonymize, don't delete) ──
      name: 'Deleted user',
      // Sparse unique indexes on email/mobile make null safe (no collision on
      // the implicit null). Nulling frees the identifier for reuse.
      email: null,
      mobile: null,
      profilePicture: null,
      // Anonymize the public handle to a non-PII stable stub so historical
      // audit URLs (`/u/<handle>`) still resolve to *something* without leaking
      // the prior identity.
      handle: `user-${userIdHex}`,
      handleChangedAt: null,

      // ── Auth secrets (no basis to retain a hash/token after erasure) ──
      passwordHash: null,
      pinHash: null,
      pinSetAt: null,
      pinAttempts: 0,
      pinLockedUntil: null,
      googleId: null,
      resetPasswordTokenHash: null,
      resetPasswordExpiresAt: null,
      emailVerificationToken: null,
      mobileVerificationToken: null,
      mobileVerificationExpiresAt: null,
      mobileOtpAttempts: 0,
      mobileOtpLockedUntil: null,
      mobileOtpLastSentAt: null,
      mobileVerificationFlow: null,

      // ── Verification flags reset (the channels no longer exist) ──
      isEmailVerified: false,
      isMobileVerified: false,

      // ── Device binding + basis-less preferences ──
      fcmToken: null,
      fcmTokenUpdatedAt: null,
      appLockIdleMs: null,
      dismissedHints: [],
      sessionLimitOverride: null,
      accountantWorkspaces: [],
      // Platform role flag — no retention basis after erasure.
      isAdmin: false,
      // Connect kill-switch off — the erased account cannot use Connect.
      connectEnabled: false,

      // ── Lifecycle ──
      isActive: false,
      deletedAt: new Date(),
    };
    // NOTE (Bucket B — KEPT, not in this patch): razorpayCustomerId +
    // billingProfile stay for the 8-year billing/GST reconciliation basis.
    // NOTE (Bucket D — KEPT): deactivatedAt / deactivationNote /
    // connectPolicyAcceptedAt / erpPolicyAcceptedAt are audit/consent stamps.
    // NOTE (Statutory — KEPT in OTHER collections): salary/attendance rows are
    // never touched here; their FK to this (now-anonymized) User stub stays.
  }

  /**
   * Erase a user account: revoke all sessions, scrub Bucket C, anonymize
   * identity, retain statutory/billing/audit data. Admin-triggered only.
   *
   * @param userId  the account to erase
   * @param actorId the admin performing the action (for audit attribution)
   * @param reason  optional free-text reason captured in the audit entry
   */
  async eraseAccount(
    userId: string,
    actorId: string,
    reason?: string,
    options?: { allowSelf?: boolean; initiatedBy?: string },
  ): Promise<{
    ok: true;
    userId: string;
    sessionsRevoked: number;
    retained: { billing: boolean; statutory: 'preserved-in-owning-modules' };
  }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User not found');
    }

    // AUTH-H4: privilege-orphan guard. Block self-erase so an admin cannot wipe
    // their own account (and lock themselves out / abandon the action mid-scrub),
    // and reject erasing the last remaining active admin so platform admin access
    // can never be orphaned. These are admin-only API errors — a precise,
    // stable error code/message is enough (no end-user i18n).
    //
    // Account-deletion Phase 1 (§A.5): the self-serve Day-30 finalize calls this
    // with the REAL userId as actor + `allowSelf:true`, so the self-block is
    // bypassed ONLY for that explicit, server-driven path; the admin endpoint
    // never passes allowSelf, so it keeps ERASURE_SELF_BLOCKED.
    if (userId === actorId && !options?.allowSelf) {
      throw new ConflictException({
        code: 'ERASURE_SELF_BLOCKED',
        message: 'You cannot erase your own account.',
      });
    }

    // Select isAdmin too — the last-admin check needs it.
    const user = await this.userModel.findById(userId).select('name email mobile isAdmin').exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // AUTH-H4a (TOCTOU fix): the last-admin guard is a check-then-act invariant
    // (count OTHER active admins, then demote/scrub this admin). The count and
    // the demote are NOT atomic: two erasures targeting the two final admins can
    // each read "1 other admin remains" BEFORE either has written isAdmin:false,
    // so both pass the guard and both scrub — orphaning ALL platform admin
    // access. We close that race by serializing the *entire* check-then-scrub for
    // an ADMIN target under a short-lived global "admin roster" mutex (the same
    // Redis lock utility the migration runner uses, here in BLOCKING `withLock`
    // mode so the second erasure waits its turn rather than skipping). Because
    // the first erasure's scrub (which flips isAdmin:false) commits BEFORE the
    // lock is released, the second erasure's count runs AFTER that write and
    // correctly sees 0 other admins remaining → it is blocked. The common,
    // non-admin path takes NO lock (no added latency).
    if (user.isAdmin === true) {
      return this.singleFlight.withLock(
        ADMIN_ROSTER_LOCK,
        async () => {
          // Re-assert the invariant INSIDE the lock so the count reflects every
          // already-committed concurrent demote (the extracted guard counts
          // OTHER active admins and throws ERASURE_LAST_ADMIN_BLOCKED at zero).
          await this.assertNotLastActiveAdmin(userId);
          // The scrub (isAdmin:false) MUST happen inside the lock so the next
          // waiter's count sees this demote and can't also drop below one admin.
          return this.performErasure(user, userId, actorId, reason, options?.initiatedBy);
        },
        // The critical section is one count + one update — sub-second in practice.
        // Generous TTL so a transient stall can't strand a holder; bounded wait so
        // a wedged holder surfaces a clean error instead of hanging the request.
        { ttlMs: 10_000, waitMs: 10_000, pollMs: 25 },
      );
    }

    // Non-admin target: no privilege-orphan risk, so no lock — the common path
    // stays lock-free.
    return this.performErasure(user, userId, actorId, reason, options?.initiatedBy);
  }

  /**
   * Privilege-orphan guard (AUTH-H4), extracted so the account-deletion SCHEDULE
   * path can call it SYNCHRONOUSLY before any state change (block a sole admin
   * from scheduling their own deletion — otherwise admin access is orphaned for
   * the whole 30-day grace and may dead-lock at purge). Plan §A.4.
   *
   * No-op for a non-admin target (it can never be the last admin). For an admin
   * target, counts OTHER active, non-deleted admins and throws a 409
   * ERASURE_LAST_ADMIN_BLOCKED when none remain. `eraseAccount` re-asserts this
   * inside the ADMIN_ROSTER_LOCK at purge so the count is race-free there; this
   * standalone (lock-free) call is the cheap pre-check at schedule time.
   */
  async assertNotLastActiveAdmin(userId: string): Promise<void> {
    const user = await this.userModel.findById(userId).select('isAdmin').exec();
    if (!user?.isAdmin) return;
    const otherActiveAdmins = await this.userModel
      .countDocuments({
        _id: { $ne: user._id },
        isAdmin: true,
        isActive: true,
        deletedAt: { $in: [null, undefined] },
      })
      .exec();
    if (otherActiveAdmins === 0) {
      throw new ConflictException({
        code: 'ERASURE_LAST_ADMIN_BLOCKED',
        message: 'Cannot erase the last active admin — at least one active admin must remain.',
      });
    }
  }

  /**
   * The destructive half of erasure: revoke sessions, scrub Bucket C, invalidate
   * the claims cache, audit. Split out from {@link eraseAccount} so the admin
   * path can run the last-admin check + this scrub atomically under the
   * admin-roster mutex (AUTH-H4a) while the non-admin path calls it directly.
   * Callers are responsible for the privilege-orphan guard BEFORE invoking this.
   */
  private async performErasure(
    user: User & { _id: Types.ObjectId },
    userId: string,
    actorId: string,
    reason?: string,
    initiatedBy?: string,
  ): Promise<{
    ok: true;
    userId: string;
    sessionsRevoked: number;
    retained: { billing: boolean; statutory: 'preserved-in-owning-modules' };
  }> {
    // Snapshot the pre-erasure name for the audit trail BEFORE we scrub it —
    // the audit row keeps a name snapshot (the live User doc will read "Deleted
    // user" after this), so historical audit entries stay interpretable.
    const nameSnapshot = user.name;

    // 0. OQ-W4 (approved Option B) — auto-soft-delete every workspace this user
    //    still OWNS, BEFORE the identity scrub, so we never leave a workspace
    //    orphaned with an ownerId pointing at a now-anonymized "Deleted user"
    //    stub that no one can manage, delete, or transfer. Reuses the Workspaces
    //    soft-delete path (credential scrub included); statutory data is retained
    //    (anonymize-don't-delete cascade), just hidden. Best-effort: a failure
    //    here must NOT abort the DPDP identity scrub (the more important
    //    obligation) — log + Sentry and continue.
    let ownedWorkspacesSoftDeleted = 0;
    if (this.workspacesService) {
      try {
        const res = await this.workspacesService.softDeleteAllOwnedForErasure(userId);
        ownedWorkspacesSoftDeleted = res.softDeleted;
      } catch (err) {
        this.logger.error(
          `[eraseAccount] owned-workspace soft-delete failed for ${userId} (continuing to scrub): ${(err as Error)?.message ?? err}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'auth', op: 'eraseAccount.softDeleteOwnedWorkspaces' },
          extra: { userId },
        });
      }
    }

    // 1. Revoke ALL active sessions account-wide (denylist every jti + token
    //    hash, deactivate every session row). This is the account-level
    //    equivalent of the Team offboarding access-revoke; cross-workspace by
    //    design (the user can no longer log in anywhere). We coordinate with —
    //    not duplicate — the Team cascade: workspace membership rows are left to
    //    the Team module's offboarding/retention.
    let sessionsRevoked = 0;
    try {
      sessionsRevoked = await this.sessionsService.invalidateAllSessions(userId);
    } catch (err) {
      // A session-revoke failure must not abort the PII scrub (the more
      // important DPDP obligation). Log + Sentry; the scrub proceeds.
      this.logger.error(
        `[eraseAccount] session revoke failed for ${userId} (continuing to scrub): ${(err as Error)?.message ?? err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'auth', op: 'eraseAccount.revokeSessions' },
        extra: { userId },
      });
    }

    // 2. Scrub Bucket C + anonymize identity in one atomic update. Bucket B
    //    (razorpayCustomerId / billingProfile) and Bucket D (audit/consent
    //    stamps) are intentionally absent from the patch, so they are retained.
    //    For an admin target this update (which sets isAdmin:false) runs while we
    //    still hold the admin-roster mutex (AUTH-H4a), so the demote is visible to
    //    the next waiter's count before the lock is released.
    const patch = AccountErasureService.buildBucketCScrubPatch(user._id.toString());
    await this.userModel.updateOne({ _id: user._id }, { $set: patch }).exec();

    // 3. Drop the JWT hot-path claims cache (OQ-2) so any in-flight token for
    //    this user is rejected on its next request (isActive is now false +
    //    the cached email/mobile are stale).
    await this.userClaimsCache.invalidate(userId);

    // 4. Audit the erasure. workspaceId:null (identity-layer event). actorId is
    //    the admin, NOT the erased user (actor-correct audit). The name
    //    snapshot is the PRE-erasure name so the trail stays meaningful.
    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'account_erased',
        actorId,
        actorNameSnapshot: nameSnapshot,
        reason,
        meta: {
          sessionsRevoked,
          // Who drove this erasure: 'admin' (admin endpoint) or 'self-serve'
          // (account-deletion Day-30 finalize, actor === target). Part of the
          // grievance/audit trail (§8).
          initiatedBy: initiatedBy ?? 'admin',
          // OQ-W4 — count of owned workspaces auto-soft-deleted as part of erasure
          // (anonymize-don't-delete; statutory data retained, workspace hidden).
          ownedWorkspacesSoftDeleted,
          // Record the legal basis for what was KEPT (DPDP requirement: when
          // honouring erasure but retaining under a carve-out, record the basis).
          retainedBilling: 'razorpayCustomerId + billingProfile (8y GST/billing basis)',
          retainedStatutory: 'salary / attendance / statutory rows in owning modules',
          scrubbedIdentity: true,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[eraseAccount] audit log failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    // 5. OQ-3 — announce the erasure so the Connect profile module hides the
    //    user from public Connect surfaces AND de-indexes them from search
    //    (an erased/banned user must stop being discoverable by OTHER viewers;
    //    the JWT layer only blocks the banned user's own requests). Decoupled
    //    via the global event bus so auth keeps zero Connect dependency.
    //    Fire-and-forget + guarded: a synchronous listener throw must never
    //    propagate back into the erasure (the DPDP scrub already committed).
    try {
      const erasedEvent: AccountErasedEvent = { userId };
      this.eventEmitter?.emit(ACCOUNT_ERASED, erasedEvent);
    } catch (err) {
      this.logger.warn(
        `[eraseAccount] ACCOUNT_ERASED emit failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    this.logger.log(
      `[eraseAccount] user ${userId} erased by ${actorId}: ${sessionsRevoked} sessions revoked, identity anonymized, billing/statutory retained`,
    );

    return {
      ok: true,
      userId,
      sessionsRevoked,
      retained: { billing: true, statutory: 'preserved-in-owning-modules' },
    };
  }
}
