import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { User, type AccountDeletionMarker } from '../users/schemas/user.schema';
import { SessionsService } from '../sessions/sessions.service';
import { UserClaimsCacheService } from '../users/user-claims-cache.service';
import { AuditService } from '../audit/audit.service';
import { AccountErasureService } from '../auth/services/account-erasure.service';
import { AuthService } from '../auth/auth.service';
import { SmsOtpService } from '../auth/services/sms-otp.service';
import { MailService } from '../mail/mail.service';
import { SubscriptionMandateService } from '../subscriptions/billing/services/subscription-mandate.service';
import { ConnectProfileService } from '../connect/profile/connect-profile.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { EmployerLoan } from '../salary/schemas/employer-loan.schema';
import { AdvanceRecoveryPlan } from '../salary/schemas/advance-recovery-plan.schema';
import { AppModule } from '../../common/enums/modules.enum';
import { env } from '../../config/env';

/**
 * Recovery window for a scheduled self-serve deletion. Mirrors
 * `WORKSPACE_RESTORE_WINDOW_DAYS` (workspaces.service.ts) so the account and
 * workspace recovery clocks stay aligned. Code constant by design
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §4) — not an env knob.
 */
export const DELETION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Type-to-confirm phrase the user must type to schedule whole-account deletion
 * (plan §5/§6 "type-to-confirm" factor, alongside re-auth + step-up OTP). The
 * web Danger Zone shows a localized instruction but submits this canonical
 * token. Case-sensitive and deliberate so a delete can never fire by accident.
 */
export const DELETION_CONFIRM_PHRASE = 'DELETE';

/**
 * How many days before the irreversible Day-30 purge the "recovery window
 * closing" reminder fires (plan §3C/§7 "~Day-25 reminder"). 5 = a 30-day window
 * reminds on ~Day 25. Code constant (not env) so the guarantee is stable.
 */
export const REMINDER_BEFORE_PURGE_DAYS = 5;

/** Shape of the verified self-serve schedule input (the controller's DTO is
 *  structurally compatible — see account-deletion.dto.ts). */
interface ScheduleSelfServeInput {
  reauth?: { kind?: 'password' | 'google'; password?: string; googleIdToken?: string };
  otpProof: string;
  confirm: string;
}

/**
 * The Scope-2 "delete ERP" impact surface (plan §3B "B2" owner-with-team warning).
 * Powers the confirm screen (GET /me/deletion/erp/preview) and is echoed in the
 * schedule response so the caller can show what was/will be affected.
 */
interface ErpDeletionImpact {
  /** Owned workspaces (soft-deleted on schedule). `memberCount` excludes the owner
   *  → the size of the team that loses access (the user is sole owner). */
  ownedWorkspaces: Array<{ workspaceId: string; name: string; memberCount: number }>;
  /** Workspaces the user is offboarded from (NOT auto-rejoinable on recovery). */
  memberWorkspaces: Array<{ workspaceId: string; name: string }>;
  /** True when any owned workspace has a team that will lose access on delete. */
  teamLosesAccess: boolean;
  /** True when there are member workspaces (re-invite required to rejoin). */
  memberWorkspacesNeedReinvite: boolean;
  /** Outstanding employer loans in the owned workspaces (warn, not block). */
  openEmployerLoans: number;
  /** Outstanding unpaid salary advances in the owned workspaces (warn, not block). */
  unpaidAdvances: number;
}

/** Per-scope deletion markers on the User row, mapped to their short scope name. */
const DELETION_SCOPES = [
  { field: 'accountDeletion', name: 'account' },
  { field: 'connectDeletion', name: 'connect' },
  { field: 'erpDeletion', name: 'erp' },
] as const;

/**
 * Account-deletion Phase 1 — the auth-gating SCHEDULE + admin RESTORE primitives
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3C soft phase, §5, §A.4).
 *
 * SCOPE (Phase 1 only): the account-level (Scope 3) suspend mechanic + the
 * admin-mediated recovery. The per-scope Connect/ERP soft phases, the verified
 * self-serve `/me/deletion/*` endpoints, and the Day-30 finalize are Phase 2+;
 * this service is the prerequisite they build on. It deliberately does NOT run
 * the Connect hide / workspace soft-delete here (Phase 2-4).
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly accountErasure: AccountErasureService,
    private readonly sessionsService: SessionsService,
    private readonly userClaimsCache: UserClaimsCacheService,
    private readonly auditService: AuditService,
    // Phase 2 — the verified self-serve schedule orchestration. AuthService
    // re-authenticates the caller (password/Google/OTP-only); SmsOtpService
    // burns the single-use step-up proof. Both are exported by AuthModule
    // (already imported), which never imports this module → no cycle.
    private readonly authService: AuthService,
    private readonly smsOtp: SmsOtpService,
    // Best-effort schedule-time side-effects (plan §3C): cancel subscription
    // auto-renew + email the confirmation. @Optional so the direct-construction
    // unit tests (which exercise the Phase-1 primitives only) keep compiling and
    // a missing provider degrades gracefully — these must NEVER abort the suspend.
    // SubscriptionMandateService is @Global (BillingModule); MailService via MailModule.
    @Optional() private readonly mailService?: MailService,
    @Optional() private readonly mandateService?: SubscriptionMandateService,
    // Phase 3 — Scope-1 (Delete Connect): hide the profile on schedule + un-hide
    // on admin recovery. @Optional so the Phase-1/2 positional unit tests (which
    // stop before this arg) keep compiling; in the running app DI supplies it
    // (AccountDeletionModule imports ConnectProfileModule). A missing provider
    // degrades the hide to a no-op rather than breaking the schedule.
    @Optional() private readonly connectProfile?: ConnectProfileService,
    // Phase 4 — Scope-2 (Delete ERP): the ERP soft phase (owned soft-delete +
    // member offboard cascade) + admin-recovery workspace restore + the impact
    // topology. WorkspacesService is @Global so DI always supplies it; @Optional
    // keeps the Phase-1/2/3 positional unit tests (which stop earlier) compiling
    // and degrades the soft phase to a no-op if absent.
    @Optional() private readonly workspacesService?: WorkspacesService,
    // Read-only model access for the open employer-loan / unpaid-advance warning
    // flags (plan §3B). @Optional + @InjectModel: AccountDeletionModule registers
    // both via MongooseModule.forFeature (Mongoose dedups the connection-global
    // model); a missing model degrades the flag to 0.
    @Optional()
    @InjectModel(EmployerLoan.name)
    private readonly employerLoanModel?: Model<EmployerLoan>,
    @Optional()
    @InjectModel(AdvanceRecoveryPlan.name)
    private readonly advanceRecoveryPlanModel?: Model<AdvanceRecoveryPlan>,
  ) {}

  /**
   * Schedule whole-account deletion (Scope 3 soft phase, §3C):
   *   - set `accountDeletion.state='pending'` (the 30-day timer anchor) AND
   *     suspend the row (`isActive=false`);
   *   - revoke every session + drop the JWT claims cache so the user is fully
   *     logged out and cannot self-log-in (recovery is admin-mediated);
   *   - leave `email`/`mobile` populated (re-signup stays blocked) and
   *     `deletedAt` UNSET (retention crons key on deletedAt/isDeleted, never on
   *     isActive — a suspended-pending account is never mistaken for finalized).
   *
   * Guards: a sole platform admin is blocked at request time (409
   * ERASURE_LAST_ADMIN_BLOCKED) BEFORE any state change, so admin access is
   * never orphaned for the grace window. Re-scheduling an already-pending
   * account is a no-op (idempotent, §9).
   *
   * @param userId      the account to schedule (the JWT subject — never a body id)
   * @param requestedBy who triggered it (self-serve schedule: === userId)
   */
  async scheduleAccountDeletion(
    userId: string,
    requestedBy: string,
  ): Promise<{ ok: true; state: 'pending'; purgeAfter: Date; alreadyPending?: boolean }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User not found');
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Idempotent: an already-pending account is a no-op (do NOT re-suspend or
    // re-revoke). Surface the existing purgeAfter so the caller can re-show the
    // recover-by date.
    if (user.accountDeletion?.state === 'pending') {
      return {
        ok: true,
        state: 'pending',
        purgeAfter: user.accountDeletion.purgeAfter,
        alreadyPending: true,
      };
    }

    // Privilege-orphan guard FIRST — before any state change (§A.4).
    await this.accountErasure.assertNotLastActiveAdmin(userId);

    const requestedAt = new Date();
    const purgeAfter = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY_MS);
    const marker: AccountDeletionMarker = {
      state: 'pending',
      requestedAt,
      purgeAfter,
      requestedBy: new Types.ObjectId(requestedBy),
    };

    // Suspend + stamp the timer in one atomic write. Deliberately NO email/mobile
    // null + NO deletedAt — that is the Day-30 scrub, not now.
    await this.userModel
      .updateOne({ _id: user._id }, { $set: { accountDeletion: marker, isActive: false } })
      .exec();

    // Log the user out everywhere. Best-effort: a revoke/cache failure must not
    // abort the suspend (the isActive=false row + claims TTL still converge to
    // logged-out). Mirrors the erasure path's posture.
    try {
      await this.sessionsService.invalidateAllSessions(userId);
    } catch (err) {
      this.logger.error(
        `[scheduleAccountDeletion] session revoke failed for ${userId} (account already suspended): ${(err as Error)?.message ?? err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'schedule.revokeSessions' },
        extra: { userId },
      });
    }
    await this.userClaimsCache.invalidate(userId).catch((err: unknown) => {
      this.logger.warn(
        `[scheduleAccountDeletion] claims cache invalidate failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    });

    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'account_deletion_scheduled',
        actorId: requestedBy,
        actorNameSnapshot: user.name,
        meta: { scope: 'account', purgeAfter, graceDays: DELETION_GRACE_DAYS },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[scheduleAccountDeletion] audit log failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    this.logger.log(
      `[scheduleAccountDeletion] user ${userId} suspended + scheduled for deletion (purgeAfter=${purgeAfter.toISOString()}) by ${requestedBy}`,
    );

    return { ok: true, state: 'pending', purgeAfter };
  }

  /**
   * Verified self-serve whole-account deletion (Scope 3, plan §3C/§5/§6). The
   * single entry point behind `POST /me/deletion/account`. Gates the action with
   * the three required factors, then runs the existing soft phase:
   *
   *   1. **type-to-confirm** — `confirm` must equal {@link DELETION_CONFIRM_PHRASE}.
   *   2. **re-auth** — password (if set) / Google / OTP-only proof, via
   *      {@link AuthService.assertReauthenticated}.
   *   3. **step-up OTP proof** — a single-use nonce burned by
   *      {@link SmsOtpService.consumeStepupProof} (replay defence, §5).
   *
   * Only after all three pass does it call {@link scheduleAccountDeletion}
   * (suspend + logout + 30-day timer). On the FIRST schedule (not an idempotent
   * re-call) it also fires two best-effort side-effects that must never abort the
   * already-committed suspend: cancel subscription auto-renew + email the
   * confirmation (recover-by date + contact link). `userId` is always the JWT
   * subject — there is no body-supplied id.
   */
  async scheduleSelfServeAccountDeletion(
    userId: string,
    input: ScheduleSelfServeInput,
  ): Promise<{ ok: true; state: 'pending'; purgeAfter: Date; alreadyPending?: boolean }> {
    // 1. Type-to-confirm — cheapest, deliberate-intent gate first (fail fast,
    //    before spending a credential check or burning the step-up proof).
    if (input.confirm !== DELETION_CONFIRM_PHRASE) {
      throw new BadRequestException({
        code: 'DELETION_CONFIRM_REQUIRED',
        message: 'Type the confirmation phrase exactly to delete your account.',
      });
    }

    // 2. Re-auth (password if set, else Google, else OTP-only — §A.11). Throws on
    //    a missing/invalid factor. Runs BEFORE the proof is consumed so a wrong
    //    password does not waste the user's one-time code.
    await this.authService.assertReauthenticated(userId, input.reauth);

    // 3. Burn the single-use step-up proof. A missing / expired / already-used
    //    nonce returns false → reject (this also defeats a replayed delete call).
    const proofOk = await this.smsOtp.consumeStepupProof(userId, input.otpProof);
    if (!proofOk) {
      throw new UnauthorizedException({
        code: 'STEPUP_PROOF_INVALID',
        message: 'Your verification has expired. Request a new code and try again.',
      });
    }

    // 4. Run the soft phase (suspend + logout + 30-day timer).
    const result = await this.scheduleAccountDeletion(userId, userId);

    // 5. First-schedule-only side-effects (idempotent re-schedule skips them).
    //    Both are best-effort: a failure must NOT roll back the suspend (the
    //    DPDP-obligation-wins posture), so each is independently guarded.
    if (!result.alreadyPending) {
      await this.cancelAutoRenewBestEffort(userId);
      await this.sendScheduledEmailBestEffort(userId, result.purgeAfter);
    }

    return result;
  }

  /**
   * Schedule Scope-1 "delete Connect" soft phase (plan §3A). UNLIKE Scope 3 this
   * does NOT suspend the account (`isActive` stays true) and does NOT revoke
   * sessions — the user keeps full ERP access; only their Connect box is hidden.
   * It:
   *   - hides the Connect profile reversibly (snapshot + de-index + ERP-consent
   *     revoke + entity unlink) via {@link ConnectProfileService.hideForConnectDeletion};
   *   - makes a SURGICAL `User.connectEnabled=false` write (NOT
   *     `buildBucketCScrubPatch`, which would null name/email/handle and destroy
   *     the shared ERP identity) + stamps the `connectDeletion` marker (the 30-day
   *     timer anchor; the Day-30 ConnectContentPurgeService keys on it).
   *
   * Idempotent: an already-pending Connect deletion is a no-op (§9).
   */
  async scheduleConnectDeletion(
    userId: string,
    requestedBy: string,
  ): Promise<{ ok: true; state: 'pending'; purgeAfter: Date; alreadyPending?: boolean }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User not found');
    }
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.connectDeletion?.state === 'pending') {
      return {
        ok: true,
        state: 'pending',
        purgeAfter: user.connectDeletion.purgeAfter,
        alreadyPending: true,
      };
    }

    const requestedAt = new Date();
    const purgeAfter = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY_MS);
    const marker: AccountDeletionMarker = {
      state: 'pending',
      requestedAt,
      purgeAfter,
      requestedBy: new Types.ObjectId(requestedBy),
    };

    // Durable intent first: the surgical connectEnabled flip + marker gate the
    // user's Connect access and anchor the Day-30 purge even if the hide below
    // transiently fails. Deliberately NO isActive change, NO deletedAt, NO
    // session revoke (Connect-only deletion keeps the ERP account fully active).
    await this.userModel
      .updateOne({ _id: user._id }, { $set: { connectEnabled: false, connectDeletion: marker } })
      .exec();

    // Hide the profile (reversible) — best-effort: a Connect-side fault must not
    // abort the schedule (the marker + connectEnabled=false still gate access and
    // the Day-30 purge runs regardless). Mirrors the resilience posture elsewhere.
    try {
      await this.connectProfile?.hideForConnectDeletion(userId);
    } catch (err) {
      this.logger.error(
        `[scheduleConnectDeletion] hide failed for ${userId} (marker already set; purge will still run): ${(err as Error)?.message ?? err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'scheduleConnect.hide' },
        extra: { userId },
      });
    }

    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'connect_deletion_scheduled',
        actorId: requestedBy,
        actorNameSnapshot: user.name,
        meta: { scope: 'connect', purgeAfter, graceDays: DELETION_GRACE_DAYS },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[scheduleConnectDeletion] audit log failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    this.logger.log(
      `[scheduleConnectDeletion] user ${userId} Connect scheduled for deletion (purgeAfter=${purgeAfter.toISOString()}) by ${requestedBy}`,
    );
    return { ok: true, state: 'pending', purgeAfter };
  }

  /**
   * Verified self-serve Scope-1 deletion (plan §3A/§5/§6) behind
   * `POST /me/deletion/connect`. Gated by the SAME three factors as Scope 3
   * (type-to-confirm + re-auth + single-use step-up proof), then runs the Connect
   * soft phase. `userId` is always the JWT subject — there is no body-supplied id.
   */
  async scheduleSelfServeConnectDeletion(
    userId: string,
    input: ScheduleSelfServeInput,
  ): Promise<{ ok: true; state: 'pending'; purgeAfter: Date; alreadyPending?: boolean }> {
    if (input.confirm !== DELETION_CONFIRM_PHRASE) {
      throw new BadRequestException({
        code: 'DELETION_CONFIRM_REQUIRED',
        message: 'Type the confirmation phrase exactly to delete your Connect profile.',
      });
    }
    await this.authService.assertReauthenticated(userId, input.reauth);
    const proofOk = await this.smsOtp.consumeStepupProof(userId, input.otpProof);
    if (!proofOk) {
      throw new UnauthorizedException({
        code: 'STEPUP_PROOF_INVALID',
        message: 'Your verification has expired. Request a new code and try again.',
      });
    }
    return this.scheduleConnectDeletion(userId, userId);
  }

  /**
   * Schedule Scope-2 "delete ERP" soft phase (plan §3B). Like Scope 1 this does
   * NOT suspend the account or revoke sessions — the user keeps their Connect box
   * and stays signed in; only their ERP footprint is torn down (reversibly):
   *   - a SURGICAL `erpDeletion` marker is stamped (audit marker / 30-day timer;
   *     the per-workspace restore windows are the real recovery anchors, §3B).
   *     Nothing else on the User row is touched (scope isolation).
   *   - the ERP soft phase runs via {@link WorkspacesService.softDeleteErpForErasure}:
   *     owned workspaces soft-deleted + credential-scrubbed, non-owner memberships
   *     offboarded through the worker cascade (kiosk PIN etc. scrubbed), and
   *     `hasWorkspace` recomputed. Best-effort — a workspace-side fault is logged
   *     but never aborts the schedule (the marker + per-workspace windows persist).
   *
   * Idempotent: an already-pending ERP deletion is a no-op (§9).
   */
  async scheduleErpDeletion(
    userId: string,
    requestedBy: string,
  ): Promise<{
    ok: true;
    state: 'pending';
    purgeAfter: Date;
    alreadyPending?: boolean;
    impact?: ErpDeletionImpact;
  }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User not found');
    }
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.erpDeletion?.state === 'pending') {
      return {
        ok: true,
        state: 'pending',
        purgeAfter: user.erpDeletion.purgeAfter,
        alreadyPending: true,
      };
    }

    // Snapshot the impact BEFORE the soft-delete (afterwards the owned workspaces
    // are gone) so the response can echo what was affected (B2 warning surface).
    const impact = await this.getErpDeletionImpact(userId);

    const requestedAt = new Date();
    const purgeAfter = new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY_MS);
    const marker: AccountDeletionMarker = {
      state: 'pending',
      requestedAt,
      purgeAfter,
      requestedBy: new Types.ObjectId(requestedBy),
    };

    // Durable intent first: the surgical erpDeletion marker. Deliberately NO
    // isActive change, NO connectEnabled change, NO deletedAt, NO session revoke —
    // Scope 2 keeps the person + their Connect box fully active.
    await this.userModel.updateOne({ _id: user._id }, { $set: { erpDeletion: marker } }).exec();

    // Run the reversible ERP soft phase. Best-effort: a workspace-side fault must
    // not abort the schedule — the marker + the per-workspace 30-day restore
    // windows still anchor recovery (plan §3B). Mirrors the module's posture.
    try {
      await this.workspacesService?.softDeleteErpForErasure(userId);
    } catch (err) {
      this.logger.error(
        `[scheduleErpDeletion] ERP soft phase failed for ${userId} (marker set; per-workspace windows still anchor recovery): ${(err as Error)?.message ?? err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'scheduleErp.softPhase' },
        extra: { userId },
      });
    }

    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'erp_deletion_scheduled',
        actorId: requestedBy,
        actorNameSnapshot: user.name,
        meta: {
          scope: 'erp',
          purgeAfter,
          graceDays: DELETION_GRACE_DAYS,
          ownedWorkspaces: impact.ownedWorkspaces.length,
          memberWorkspaces: impact.memberWorkspaces.length,
          openEmployerLoans: impact.openEmployerLoans,
          unpaidAdvances: impact.unpaidAdvances,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[scheduleErpDeletion] audit log failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    this.logger.log(
      `[scheduleErpDeletion] user ${userId} ERP scheduled for deletion (purgeAfter=${purgeAfter.toISOString()}) by ${requestedBy}`,
    );
    return { ok: true, state: 'pending', purgeAfter, impact };
  }

  /**
   * Verified self-serve Scope-2 deletion (plan §3B/§5/§6) behind
   * `POST /me/deletion/erp`. Gated by the SAME three factors as Scope 1/3
   * (type-to-confirm + re-auth + single-use step-up proof), then runs the ERP soft
   * phase. `userId` is always the JWT subject — there is no body-supplied id.
   */
  async scheduleSelfServeErpDeletion(
    userId: string,
    input: ScheduleSelfServeInput,
  ): Promise<{
    ok: true;
    state: 'pending';
    purgeAfter: Date;
    alreadyPending?: boolean;
    impact?: ErpDeletionImpact;
  }> {
    if (input.confirm !== DELETION_CONFIRM_PHRASE) {
      throw new BadRequestException({
        code: 'DELETION_CONFIRM_REQUIRED',
        message: 'Type the confirmation phrase exactly to delete your business workspaces.',
      });
    }
    await this.authService.assertReauthenticated(userId, input.reauth);
    const proofOk = await this.smsOtp.consumeStepupProof(userId, input.otpProof);
    if (!proofOk) {
      throw new UnauthorizedException({
        code: 'STEPUP_PROOF_INVALID',
        message: 'Your verification has expired. Request a new code and try again.',
      });
    }
    return this.scheduleErpDeletion(userId, userId);
  }

  /**
   * The Scope-2 deletion impact (plan §3B "B2" warning surface): the workspaces a
   * "delete ERP" will tear down + the consequences worth warning about. Read-only;
   * powers the confirm screen (GET /me/deletion/erp/preview) and is echoed in the
   * schedule response. The workspace topology comes from
   * {@link WorkspacesService.getErpDeletionImpact}; the open employer-loan /
   * unpaid-advance flags are counted over the OWNED workspaces here.
   */
  async getErpDeletionImpact(userId: string): Promise<ErpDeletionImpact> {
    const topo: {
      owned: Array<{ workspaceId: string; name: string; memberCount: number }>;
      member: Array<{ workspaceId: string; name: string }>;
    } = (await this.workspacesService?.getErpDeletionImpact(userId)) ?? { owned: [], member: [] };

    let openEmployerLoans = 0;
    let unpaidAdvances = 0;
    const ownedIds = topo.owned.map((w) => new Types.ObjectId(w.workspaceId));
    if (ownedIds.length > 0) {
      // "Open" = still being recovered (active or paused) → outstanding money. The
      // inline status arrays mirror the existing salary queries (loan.service.ts /
      // salary.service.ts) so they contextually narrow to each model's enum.
      openEmployerLoans =
        (await this.employerLoanModel
          ?.countDocuments({
            workspaceId: { $in: ownedIds },
            status: { $in: ['active', 'paused'] },
          })
          .exec()) ?? 0;
      unpaidAdvances =
        (await this.advanceRecoveryPlanModel
          ?.countDocuments({
            workspaceId: { $in: ownedIds },
            status: { $in: ['active', 'paused'] },
          })
          .exec()) ?? 0;
    }

    return {
      ownedWorkspaces: topo.owned,
      memberWorkspaces: topo.member,
      teamLosesAccess: topo.owned.some((w) => w.memberCount > 0),
      memberWorkspacesNeedReinvite: topo.member.length > 0,
      openEmployerLoans,
      unpaidAdvances,
    };
  }

  /**
   * ~Day-25 reminder sweep (plan §3C/§7): email every pending account whose
   * recovery window closes within {@link REMINDER_BEFORE_PURGE_DAYS} days and
   * that has not been reminded yet, then stamp `reminderSentAt` so the reminder
   * fires at most once per pending deletion. Called by the daily reminder cron.
   * Per-account best-effort — one failure never aborts the sweep.
   */
  async remindDuePending(): Promise<{ scanned: number; reminded: number }> {
    const now = Date.now();
    const windowEnd = new Date(now + REMINDER_BEFORE_PURGE_DAYS * DAY_MS);

    // Only PENDING accounts inside the [now, now+window] runway whose reminder
    // has not been sent. Accounts already past purgeAfter belong to the finalize
    // cron (a "N days left" reminder there would be nonsensical), so we exclude
    // them with the `$gt: now` bound.
    const candidates = await this.userModel
      .find({
        'accountDeletion.state': 'pending',
        'accountDeletion.purgeAfter': { $gt: new Date(now), $lte: windowEnd },
        'accountDeletion.reminderSentAt': { $in: [null, undefined] },
      })
      .select('email name accountDeletion')
      .lean()
      .exec();

    let reminded = 0;
    for (const u of candidates as Array<{
      _id: Types.ObjectId;
      email?: string;
      name?: string;
      accountDeletion?: AccountDeletionMarker;
    }>) {
      const purgeAfter = u.accountDeletion?.purgeAfter
        ? new Date(u.accountDeletion.purgeAfter)
        : null;
      // No email on file → cannot send (an SMS channel may be added later, plan
      // §8). Leave reminderSentAt unset; the row is cheaply re-scanned next run.
      if (!u.email || !purgeAfter) continue;

      const daysLeft = Math.max(1, Math.ceil((purgeAfter.getTime() - now) / DAY_MS));
      try {
        await this.mailService?.sendAccountDeletionReminderEmail({
          to: u.email,
          name: u.name ?? '',
          recoverByDate: purgeAfter,
          daysLeft,
          contactUrl: env.accountDeletion.contactUrl,
        });
        // Stamp AFTER the send so a send failure leaves the row eligible for a
        // retry on the next run (dedup only what we actually delivered).
        await this.userModel
          .updateOne({ _id: u._id }, { $set: { 'accountDeletion.reminderSentAt': new Date() } })
          .exec();
        reminded++;
      } catch (err) {
        this.logger.warn(
          `[remindDuePending] reminder failed for ${u._id.toString()}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'account-deletion', op: 'remind' },
          extra: { userId: u._id.toString() },
        });
      }
    }

    if (candidates.length > 0) {
      this.logger.log(
        `[remindDuePending] scanned ${candidates.length} pending account(s), reminded ${reminded}.`,
      );
    }
    return { scanned: candidates.length, reminded };
  }

  /**
   * Best-effort cancel of any recurring subscription auto-renew at schedule time
   * (plan §3C — no auto-charge during the grace window). `cancelAtCycleEnd` so
   * the user keeps access through the grace they paid for. A `NotFoundException`
   * (no active mandate — the common free-tier case) is the expected no-op; any
   * other error is logged + Sentry'd but never propagated.
   */
  private async cancelAutoRenewBestEffort(userId: string): Promise<void> {
    if (!this.mandateService) return;
    try {
      await this.mandateService.cancelMandate(userId, { cancelAtCycleEnd: true });
      this.logger.log(`[scheduleSelfServe] auto-renew cancelled for ${userId}`);
    } catch (err) {
      if (err instanceof NotFoundException) return; // no mandate → nothing to cancel
      this.logger.warn(
        `[scheduleSelfServe] cancel auto-renew failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'schedule.cancelAutoRenew' },
        extra: { userId },
      });
    }
  }

  /**
   * Best-effort confirmation email at schedule time (plan §3C/§7): recover-by
   * date + contact link (recovery is admin-mediated — no self-cancel). Skips
   * silently when there is no email on file; never throws.
   */
  private async sendScheduledEmailBestEffort(userId: string, purgeAfter: Date): Promise<void> {
    if (!this.mailService) return;
    try {
      const user = await this.userModel.findById(userId).select('email name').exec();
      if (!user?.email) return;
      await this.mailService.sendAccountDeletionScheduledEmail({
        to: user.email,
        name: user.name ?? '',
        recoverByDate: purgeAfter,
        contactUrl: env.accountDeletion.contactUrl,
      });
    } catch (err) {
      this.logger.warn(
        `[scheduleSelfServe] confirmation email failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'account-deletion', op: 'schedule.confirmEmail' },
        extra: { userId },
      });
    }
  }

  /**
   * Admin-mediated recovery (§5): within the 30-day window, clear the pending
   * deletion markers + reactivate the account (`isActive=true`) + drop the
   * claims cache. Requires the caller to pass the target id under IsAdminGuard;
   * there is NO self-cancel.
   *
   * Scope-aware layering: restoring the Connect scope re-enables `connectEnabled`
   * + un-hides the profile (Phase 3); restoring the ERP scope best-effort restores
   * the owned workspaces this deletion soft-deleted (Phase 4) — member workspaces
   * are NOT auto-rejoinable (re-invite required), surfaced via
   * `memberWorkspacesNeedReinvite`.
   */
  async restoreDeletion(
    userId: string,
    actorId: string,
    reason?: string,
  ): Promise<{
    ok: true;
    restored: string[];
    workspaces?: { restored: string[]; failed: Array<{ workspaceId: string; code?: string }> };
    memberWorkspacesNeedReinvite?: boolean;
  }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('User not found');
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const userRecord = user as unknown as Record<string, AccountDeletionMarker | undefined>;
    const pending = DELETION_SCOPES.flatMap((s) => {
      const marker = userRecord[s.field];
      return marker?.state === 'pending' ? [{ field: s.field, name: s.name, marker }] : [];
    });

    if (pending.length === 0) {
      throw new ConflictException({
        code: 'NO_PENDING_DELETION',
        message: 'This account has no pending deletion to recover.',
      });
    }

    // Recovery is only possible while the window is open; once purgeAfter has
    // elapsed the data is due for / past the irreversible Day-30 scrub.
    const earliestPurge = Math.min(...pending.map((s) => new Date(s.marker.purgeAfter).getTime()));
    if (earliestPurge <= Date.now()) {
      throw new ConflictException({
        code: 'DELETION_WINDOW_EXPIRED',
        message:
          'The 30-day recovery window has elapsed; this account can no longer be restored from here.',
      });
    }

    const unset: Record<string, ''> = {};
    for (const s of pending) unset[s.field] = '';

    // Restoring the Connect scope re-enables the kill-switch + un-hides the
    // profile (the soft phase set connectEnabled=false + hid the profile).
    const restoringConnect = pending.some((s) => s.name === 'connect');

    await this.userModel
      .updateOne(
        { _id: user._id },
        {
          $set: { isActive: true, ...(restoringConnect ? { connectEnabled: true } : {}) },
          $unset: unset,
        },
      )
      .exec();

    // Un-hide the Connect profile (restores the snapshotted prior visibility +
    // re-indexes). Best-effort: a Connect-side fault must not fail the recovery
    // (the account is already reactivated above).
    if (restoringConnect) {
      try {
        await this.connectProfile?.unhideForConnectRecovery(userId);
      } catch (err) {
        this.logger.error(
          `[restoreDeletion] Connect un-hide failed for ${userId} (account already restored): ${(err as Error)?.message ?? err}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'account-deletion', op: 'restore.unhideConnect' },
          extra: { userId },
        });
      }
    }

    // Scope-2 recovery (plan §3B): best-effort restore of the owned workspaces this
    // deletion soft-deleted, reusing the per-workspace restore (with its 30-day
    // window + plan-limit guards → real error codes). Anchored on the erp marker's
    // requestedAt so workspaces the user deleted manually BEFORE scheduling are left
    // alone. Member workspaces are NOT auto-rejoinable — surfaced for the copy.
    const erpScope = pending.find((s) => s.name === 'erp');
    let workspaces:
      | { restored: string[]; failed: Array<{ workspaceId: string; code?: string }> }
      | undefined;
    let memberWorkspacesNeedReinvite = false;
    if (erpScope && this.workspacesService) {
      try {
        workspaces = await this.workspacesService.restoreAllOwnedForRecovery(
          userId,
          new Date(erpScope.marker.requestedAt),
        );
        memberWorkspacesNeedReinvite = true;
      } catch (err) {
        this.logger.error(
          `[restoreDeletion] workspace restore failed for ${userId} (account already reactivated): ${(err as Error)?.message ?? err}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'account-deletion', op: 'restore.workspaces' },
          extra: { userId },
        });
      }
    }

    await this.userClaimsCache.invalidate(userId).catch((err: unknown) => {
      this.logger.warn(
        `[restoreDeletion] claims cache invalidate failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    });

    const restored = pending.map((s) => s.name);
    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'account_deletion_cancelled',
        actorId,
        actorNameSnapshot: user.name,
        reason,
        meta: {
          restoredScopes: restored,
          workspacesRestored: workspaces?.restored.length ?? 0,
          workspacesRestoreFailed: workspaces?.failed.length ?? 0,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[restoreDeletion] audit log failed for ${userId}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });

    this.logger.log(
      `[restoreDeletion] user ${userId} restored (scopes=${restored.join(',')}) by ${actorId}`,
    );

    return {
      ok: true,
      restored,
      ...(workspaces ? { workspaces, memberWorkspacesNeedReinvite } : {}),
    };
  }
}
