import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';
import { User } from '../../../users/schemas/user.schema';
import {
  ConnectReferral,
  type ConnectReferralDocument,
  type ReferralStatus,
} from '../schemas/connect-referral.schema';
import { ConnectReferralConfigService } from './connect-referral-config.service';
import type { ConnectReferralConfigView } from '../schemas/connect-referral-config.schema';
import { WalletService } from '../../ads/services/wallet.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { generateReferralCode } from '../referral-code.util';
import { DISPOSABLE_EMAIL_DOMAINS } from '../disposable-domains';
import {
  CONNECT_PROFILE_CREATED,
  type ConnectProfileCreatedEvent,
} from '../../profile/events/connect-profile-created.events';
import { ConnectProfile } from '../../profile/schemas/connect-profile.schema';

/** Max attempts to generate a unique referral code before giving up (E11000 retry). */
const CODE_GEN_MAX_TRIES = 5;

/**
 * Connect Referrals -- `ReferralService` (Phase 4a: attribution side).
 *
 * What this does (Phase 4a):
 *  - `getOrCreateMyCode`: returns the caller's existing User.referralCode, else
 *    lazily generates one from their name/handle and persists it, retrying on the
 *    unique-index collision (E11000) up to a few times.
 *  - `attachReferralAtSignup`: best-effort first-code-wins attribution at signup.
 *    Resolves a referral code -> referrer, runs the anti-fraud guards (self,
 *    shared mobile/email, disposable email, daily velocity, once-only), then
 *    atomically stamps User.referredByUserId once and creates a `pending`
 *    ConnectReferral row. NEVER throws (wrapped so it can't block auth).
 *  - `onProfileCreated`: on `connect.profile.created`, promotes the referee's
 *    `pending` row to `qualified`, stamps qualifiedAt, and SNAPSHOTS the per-side
 *    credit amounts from the live config (so a later config change never reprices
 *    an already-qualified referral). NEVER throws.
 *
 * Defensiveness mirrors InstituteReferralService: every event/best-effort path is
 * wrapped, logged via Logger, and Sentry-captured with tags
 * `{ module:'connect.referral', op:... }` -- never thrown out of the handler.
 *
 * Cross-module links:
 *  - ConnectReferralConfigService -> the enabled flag + per-side credit amounts.
 *  - `User` (schema-only token on this module's forFeature) -> referralCode lookup
 *    + the first-code-wins referredByUserId stamp.
 *  - `ConnectReferral` (this module) -> the pending/qualified lifecycle rows.
 *  - listens to CONNECT_PROFILE_CREATED (profile module event; imported by name +
 *    type only, so no static dep on ConnectProfileService = no module cycle).
 *
 * Phase 4b (the payout/read/admin side) ADDS to this service WITHOUT changing any
 * Phase 4a behaviour:
 *  - `releaseHeldReferrals`: a daily cron that finds qualified referrals past their
 *    holdback, applies the cap/budget rules (`capRejectionReason`), and credits BOTH
 *    sides via WalletService.creditReferral (idempotent on its key, so a re-run never
 *    double-credits). One bad row never aborts the batch.
 *  - `getMyReferralSummary`: the caller's referral stats + recent referred list for
 *    `GET /connect/referrals/me`.
 *  - `listReferrals` + `clawback`: the admin log + the manual reversal (via
 *    WalletService.adjust) with an AuditService entry.
 *
 * Cross-module links (Phase 4b additions):
 *  - WalletService (ads module) -> creditReferral (release) + adjust (clawback reverse).
 *  - AuditService -> the audited `referral_clawback` admin write (AppModule.ADS).
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly configService: ConnectReferralConfigService,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(ConnectReferral.name)
    private readonly referralModel: Model<ConnectReferralDocument>,
    // Phase 4b: the wallet (credit both sides on release; reverse on clawback) and
    // the audit log (clawback is an admin money action). Injected after the three
    // Phase 4a deps so the existing constructor order is unchanged.
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    // Schema-only token (owned by ConnectProfileModule; re-registered read-only on
    // this module's forFeature, same safe pattern as `User`). Used ONLY to detect
    // whether the referee already has a Connect profile AT signup-attach time, so a
    // pending row that the profile-created event missed (event fired before the row
    // existed -- attach is fire-and-forget after signup) is qualified immediately
    // instead of being stuck `pending` forever. No write path touches this model.
    // Appended LAST so the existing constructor positions are unchanged.
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    // CN-REF-6 (feed harden Bucket 10): single-flight lock so the daily release
    // cron fires once across workers (was a bare @Cron — two web/worker replicas
    // could both run it). Comes from the global SchedulerModule. @Optional() +
    // LAST so positional unit-test constructors keep working; when absent (tests
    // calling releaseHeldReferrals directly) the lock is skipped and the tick
    // runs inline, so the existing release tests are unaffected.
    @Optional()
    private readonly singleFlight?: SingleFlightService,
  ) {}

  /**
   * Return the caller's shareable referral code, creating + persisting one on
   * first use. Generated from the user's name/handle; on a unique-index collision
   * (another user already holds that code) the suffix is regenerated and retried
   * up to CODE_GEN_MAX_TRIES. Throws only if every attempt collides (vanishingly
   * unlikely) -- callers on a read path should treat that as "no code this time".
   */
  async getOrCreateMyCode(userId: string): Promise<string> {
    const user = await this.userModel
      .findById(userId)
      .select('name handle referralCode')
      .lean<{ name?: string; handle?: string | null; referralCode?: string } | null>()
      .exec();
    if (user?.referralCode) return user.referralCode;

    const seed = user?.handle || user?.name || 'CR';
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < CODE_GEN_MAX_TRIES; attempt++) {
      const code = generateReferralCode(seed);
      try {
        // Conditional set: only claim the code if this user does not already have
        // one (guards a race where two concurrent calls both generate). On the
        // unique-index collision with ANOTHER user's code we retry a fresh suffix.
        const result = await this.userModel
          .updateOne(
            { _id: userId, referralCode: { $in: [null, undefined] } },
            { $set: { referralCode: code } },
          )
          .exec();
        if ((result.modifiedCount ?? 0) >= 1) {
          // This call won the race — the generated code is now persisted.
          return code;
        }
        // modifiedCount === 0: another concurrent call won the race and already
        // persisted its code. Re-read the DB to return the code actually stored.
        const updated = await this.userModel
          .findById(userId)
          .select('referralCode')
          .lean<{ referralCode?: string } | null>()
          .exec();
        if (updated?.referralCode) return updated.referralCode;
        // Shouldn't reach here — but if for some reason it's still null, let
        // the loop try again with a fresh suffix (treated like an E11000 retry).
        continue;
      } catch (err) {
        lastErr = err;
        if (!this.isDuplicateKeyError(err)) throw err;
        // E11000 -> another user holds this code; loop regenerates a new suffix.
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Failed to generate a unique referral code');
  }

  /**
   * Bind a referral at signup. Best-effort: the whole body is wrapped so it NEVER
   * blocks or fails auth (mirrors InstituteReferralService). First-code-wins:
   * referredByUserId is set exactly once via a conditional (atomic) update; a
   * pending ConnectReferral row is created only when that stamp wins.
   *
   * Guards (each a silent no-op): code missing/unknown, feature disabled,
   * referrer === referee, shared mobile/email (self-referral), disposable referee
   * email, referee already attributed, and the per-referrer daily velocity cap.
   *
   * Cross-module: called by AuthService.register (+ SMS verify) in Phase 5 after
   * the user + session exist.
   */
  async attachReferralAtSignup(input: {
    refereeUserId: string;
    code?: string | null;
    signupContext?: ConnectReferral['signupContext'];
  }): Promise<void> {
    try {
      const code = (input.code || '').trim().toUpperCase();
      if (!code) return;
      if (!input.refereeUserId || !Types.ObjectId.isValid(input.refereeUserId)) return;

      const cfg = await this.configService.getConfig();
      if (!cfg.enabled) return; // ships dark -- attribution is a no-op until flipped on.

      // Resolve the code -> referrer.
      const referrer = await this.userModel
        .findOne({ referralCode: code })
        .select('_id mobile email isActive')
        .lean<{
          _id: Types.ObjectId;
          mobile?: string | null;
          email?: string | null;
          isActive?: boolean;
        } | null>()
        .exec();
      if (!referrer) return; // unknown code.
      // A banned / deactivated referrer earns nothing: skip attribution (no-op, like
      // the other guards). isActive defaults true on every account; only an admin
      // ban / self-deactivation flips it false. Treat an explicit `false` as inactive
      // (absent/undefined -> active, so legacy rows without the field still attribute).
      if (referrer.isActive === false) return;
      if (String(referrer._id) === input.refereeUserId) return; // self (own code).

      // Load the referee's identity + attribution state.
      const referee = await this.userModel
        .findById(input.refereeUserId)
        .select('mobile email referredByUserId')
        .lean<{
          mobile?: string | null;
          email?: string | null;
          referredByUserId?: Types.ObjectId | null;
        } | null>()
        .exec();
      if (!referee || referee.referredByUserId != null) return; // once-only (first-code-wins).

      // Self-referral by shared identity (same person, two accounts).
      if (referrer.mobile && referee.mobile && referrer.mobile === referee.mobile) return;
      if (referrer.email && referee.email && referrer.email === referee.email) return;

      // Disposable referee email -> skip (cheap burner-farming guard).
      if (this.isDisposableEmail(referee.email)) return;

      // Daily velocity pre-check: cap referrals attributed to this referrer in 24h.
      if (cfg.dailyVelocityPerReferrer > 0) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recent = await this.referralModel.countDocuments({
          referrerUserId: referrer._id,
          createdAt: { $gt: since },
        });
        if (recent >= cfg.dailyVelocityPerReferrer) return;
      }

      // Stamp referredByUserId ONCE (atomic gate). If another concurrent run won
      // the stamp first, modifiedCount is 0 and we do not create a duplicate row.
      const stamp = await this.userModel
        .updateOne(
          { _id: input.refereeUserId, referredByUserId: null },
          { $set: { referredByUserId: referrer._id } },
        )
        .exec();
      if ((stamp.modifiedCount ?? 0) === 0) return;

      await this.referralModel.create({
        referrerUserId: referrer._id,
        refereeUserId: new Types.ObjectId(input.refereeUserId),
        codeUsed: code,
        status: 'pending',
        signupContext: input.signupContext,
      });

      // Ordering safety-net (event/attach race): `connect.profile.created` is
      // emitted exactly once, on the FIRST Connect onboarding -- but attribution
      // runs fire-and-forget AFTER signup, so for a referee who already had a
      // profile by the time this row was created, that event already fired and
      // `onProfileCreated` found NO pending row (it didn't exist yet), leaving this
      // row stuck `pending` forever. So: ONLY when the referee ALREADY has a
      // Connect profile (i.e. they have already activated), qualify the freshly-
      // created row right now -- mirroring exactly what the event would have done.
      // A referee with NO profile yet is left `pending`; their later first profile
      // creation fires the event and qualifies it the normal way. qualifyByRefereeId
      // is itself a no-op on a non-pending row, so this can never double-qualify.
      const refereeHasProfile = await this.refereeHasConnectProfile(input.refereeUserId);
      if (refereeHasProfile) {
        await this.qualifyByRefereeId(input.refereeUserId, cfg);
      }
    } catch (err) {
      // Never throw out of signup attribution. Log + capture only.
      this.logger.warn(
        `attachReferralAtSignup failed for referee ${input?.refereeUserId ?? '<unknown>'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      Sentry.captureException(err, {
        tags: { module: 'connect.referral', op: 'attachAtSignup' },
      });
    }
  }

  /**
   * Promote the referee's pending referral to `qualified` on first Connect
   * onboarding. Listens to CONNECT_PROFILE_CREATED (the same event institutes
   * use). The referee's phone is already OTP-verified at signup, so first profile
   * creation is the first real activation. SNAPSHOTS the per-side credit amounts
   * from the live config at this moment -- the release cron rewards from the
   * snapshot, so a later config change never reprices a qualified referral. No
   * pending row -> no-op. NEVER throws (EventEmitter2 emits synchronously inside
   * the profile create).
   */
  @OnEvent(CONNECT_PROFILE_CREATED)
  async onProfileCreated(ev: ConnectProfileCreatedEvent): Promise<void> {
    try {
      if (!ev?.userId) return;
      await this.qualifyByRefereeId(ev.userId);
    } catch (err) {
      this.logger.warn(
        `qualifyReferral failed for ${ev?.userId ?? '<unknown>'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      Sentry.captureException(err, {
        tags: { module: 'connect.referral', op: 'qualify' },
      });
    }
  }

  /**
   * Promote a referee's `pending` referral row to `qualified`, stamping
   * `qualifiedAt` and SNAPSHOTTING the per-side credit amounts from the live
   * config at this moment (so a later config change never reprices it). Shared by
   * BOTH qualify paths:
   *   - the `connect.profile.created` event handler (`onProfileCreated`), and
   *   - `attachReferralAtSignup` (when the referee ALREADY had a profile at attach
   *     time, so the event fired before the row existed -- the ordering race).
   *
   * No `pending` row -> no-op (organic signup, already-qualified, or no referral).
   * Throws only on a genuine DB fault -- BOTH callers wrap this in their own
   * try/catch (and Sentry capture), so qualify never escapes the event handler or
   * blocks signup attribution. The `cfg` is passed in by the attach path (which
   * already loaded it) to avoid a second config read; the event path lets it
   * default-load.
   */
  private async qualifyByRefereeId(
    refereeUserId: string,
    cfg?: ConnectReferralConfigView,
  ): Promise<void> {
    const config = cfg ?? (await this.configService.getConfig());
    const row = await this.referralModel.findOne({ refereeUserId, status: 'pending' }).exec();
    if (!row) return; // organic signup (no referral), already qualified, or no row yet -> nothing to do.
    row.status = 'qualified';
    row.qualifiedAt = new Date();
    row.referrerCreditAmount = config.referrerCredits;
    row.refereeCreditAmount = config.refereeCredits;
    await row.save();
  }

  /**
   * True when the referee already has a Connect profile (i.e. has activated
   * Connect). Used by the attach path to decide whether to qualify a freshly-
   * created pending row immediately (the event/attach ordering race). Read-only,
   * keyed on `ConnectProfile.userId` (1:1 with User). An ObjectId match query --
   * the userId is validated as an ObjectId earlier in the attach flow.
   */
  private async refereeHasConnectProfile(refereeUserId: string): Promise<boolean> {
    const exists = await this.profileModel
      .exists({ userId: new Types.ObjectId(refereeUserId) })
      .exec();
    return exists != null;
  }

  // ===========================================================================
  // Phase 4b -- payout (cron), read (summary), admin (list + clawback).
  // ===========================================================================

  /**
   * Daily cron: release qualified referrals whose holdback has elapsed, crediting
   * BOTH sides if still within the cap/budget rules.
   *
   * What: scans `status:'qualified'` rows older than `qualifiedAt + holdbackDays`
   *   (oldest first so caps/budget fill fairly in arrival order). For each row it
   *   first asks `capRejectionReason`: a non-null reason rejects the row (no credit);
   *   otherwise it credits each side with a positive amount via WalletService.
   * Cross-module: WalletService.creditReferral (the `referral` ledger type), keyed
   *   `referral:<id>:referrer` / `referral:<id>:referee`. AdvertiserWallet balances move.
   * Watch (money correctness):
   *   - The `enabled` short-circuit means a disabled program never pays out.
   *   - The state guard (only `status:'qualified'` rows are scanned) + creditReferral's
   *     per-key idempotency mean releasing a row twice neither double-credits nor
   *     double-flips state: a re-run after `rewarded` simply never matches the row.
   *   - Each row is wrapped in try/catch so one bad row (e.g. a transient wallet
   *     fault) never aborts the batch; the failure is logged + Sentry-tagged and the
   *     row stays `qualified` for the next run to retry safely (the keys make the
   *     retry credit exactly once even if one side was already credited).
   *   - A side with amount <= 0 is skipped (no ledger row), so a 0-credit config for
   *     one side still rewards the other.
   *
   * `now` is injectable so the unit tests can drive the holdback cutoff deterministically.
   */
  // CN-REF-6: the scheduled entry point — single-flight wrapped so exactly one
  // worker runs the release per day (money path). The tick body stays a
  // separately-callable method so the unit tests can drive it directly. When no
  // SingleFlightService is injected (tests) the tick runs inline.
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: CronJobKey.CONNECT_REFERRAL_RELEASE })
  async runReleaseCron(): Promise<void> {
    if (!this.singleFlight) {
      await this.releaseHeldReferrals();
      return;
    }
    await this.singleFlight.runExclusive(CronJobKey.CONNECT_REFERRAL_RELEASE, dayBucket(), () =>
      this.releaseHeldReferrals(),
    );
  }

  async releaseHeldReferrals(now: Date = new Date()): Promise<void> {
    const cfg = await this.configService.getConfig();
    if (!cfg.enabled) return; // a disabled program never pays out.

    const cutoffMs = now.getTime() - cfg.holdbackDays * 24 * 60 * 60 * 1000;
    const due = await this.referralModel
      .find({ status: 'qualified', qualifiedAt: { $lte: new Date(cutoffMs) } })
      .sort({ qualifiedAt: 1 }) // oldest first -- caps/budget fill in arrival order.
      .exec();

    for (const row of due) {
      try {
        // Cap / budget gate. A non-null reason rejects the row WITHOUT crediting.
        const reason = await this.capRejectionReason(row, cfg, now);
        if (reason) {
          row.status = 'rejected';
          row.rejectionReason = reason;
          await row.save();
          continue;
        }

        // Credit each side (only when its snapshotted amount is positive). The
        // idempotency key per side makes a retried release credit exactly once.
        if (row.referrerCreditAmount > 0) {
          const r = await this.wallet.creditReferral(
            String(row.referrerUserId),
            row.referrerCreditAmount,
            {
              idempotencyKey: `referral:${String(row._id)}:referrer`,
              referralId: String(row._id),
              recordedBy: 'system',
            },
          );
          row.referrerLedgerId = new Types.ObjectId(r.ledgerId);
        }
        if (row.refereeCreditAmount > 0) {
          const e = await this.wallet.creditReferral(
            String(row.refereeUserId),
            row.refereeCreditAmount,
            {
              idempotencyKey: `referral:${String(row._id)}:referee`,
              referralId: String(row._id),
              recordedBy: 'system',
            },
          );
          row.refereeLedgerId = new Types.ObjectId(e.ledgerId);
        }

        row.status = 'rewarded';
        row.rewardedAt = now;
        await row.save();
      } catch (err) {
        // One bad row never aborts the batch -- it stays `qualified` for the next
        // run, and creditReferral's keys make that retry credit exactly once.
        this.logger.warn(
          `releaseHeldReferrals failed for referral ${String(row._id)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        Sentry.captureException(err, {
          tags: { module: 'connect.referral', op: 'release' },
        });
      }
    }
  }

  /**
   * Decide whether a qualified row must be REJECTED rather than rewarded, by
   * checking the four configured ceilings against the already-rewarded history.
   * Returns the rejection reason, or null when the row is clear to reward.
   *
   * Each ceiling of 0 means "unlimited" (that check is skipped). Order:
   *   1. perReferrerCap         -- lifetime rewarded count for this referrer.
   *   2. monthlyPerReferrerCap  -- rewarded count for this referrer THIS calendar month.
   *   3. annualCreditCeilingPerUser -- Σ rewarded `referrerCreditAmount` for this
   *      referrer in the current INDIAN financial year (Apr 1 -> Mar 31) [194R guard].
   *   4. totalBudgetCap         -- Σ ALL rewarded credit (both sides, program-wide).
   *
   * Counts/sums look only at `status:'rewarded'` rows (the row being released is
   * still `qualified`, so it never counts itself). `>=` is the boundary: hitting the
   * cap means THIS release would breach it, so it is rejected.
   */
  private async capRejectionReason(
    row: ConnectReferralDocument,
    cfg: ConnectReferralConfigView,
    now: Date,
  ): Promise<'cap_exceeded' | 'budget_exceeded' | null> {
    const referrerId = row.referrerUserId;

    // 1. Lifetime rewarded count for this referrer.
    if (cfg.perReferrerCap > 0) {
      const lifetime = await this.referralModel.countDocuments({
        referrerUserId: referrerId,
        status: 'rewarded',
      });
      if (lifetime >= cfg.perReferrerCap) return 'cap_exceeded';
    }

    // 2. Rewarded count for this referrer in the current calendar month.
    // Built in UTC (Date.UTC) so the [monthStart, nextMonthStart) window aligns
    // with the UTC `rewardedAt` timestamps -- a local-time `new Date(y, m, 1)`
    // would skew the boundary by the server's TZ offset.
    if (cfg.monthlyPerReferrerCap > 0) {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const thisMonth = await this.referralModel.countDocuments({
        referrerUserId: referrerId,
        status: 'rewarded',
        rewardedAt: { $gte: monthStart, $lt: nextMonthStart },
      });
      if (thisMonth >= cfg.monthlyPerReferrerCap) return 'cap_exceeded';
    }

    // 3. Σ rewarded referrer credit for this referrer this Indian financial year.
    if (cfg.annualCreditCeilingPerUser > 0) {
      const { start, end } = this.indianFinancialYearBounds(now);
      const annual = await this.sumRewardedCredit({
        referrerUserId: referrerId,
        rewardedAt: { $gte: start, $lt: end },
      });
      // Adding THIS row's referrer credit would breach the per-user FY ceiling.
      if (annual + row.referrerCreditAmount > cfg.annualCreditCeilingPerUser) {
        return 'cap_exceeded';
      }
    }

    // 4. Σ ALL rewarded credit program-wide (both sides) vs the total budget.
    if (cfg.totalBudgetCap > 0) {
      const spentBothSides = await this.sumRewardedCreditBothSides({});
      const thisRow = row.referrerCreditAmount + row.refereeCreditAmount;
      if (spentBothSides + thisRow > cfg.totalBudgetCap) return 'budget_exceeded';
    }

    return null;
  }

  /** Σ `referrerCreditAmount` over rewarded rows matching `match`. */
  private async sumRewardedCredit(match: Record<string, unknown>): Promise<number> {
    const [agg] = await this.referralModel.aggregate<{ total: number }>([
      { $match: { status: 'rewarded', ...match } },
      { $group: { _id: null, total: { $sum: '$referrerCreditAmount' } } },
    ]);
    return agg?.total ?? 0;
  }

  /** Σ (`referrerCreditAmount` + `refereeCreditAmount`) over rewarded rows matching `match`. */
  private async sumRewardedCreditBothSides(match: Record<string, unknown>): Promise<number> {
    const [agg] = await this.referralModel.aggregate<{ total: number }>([
      { $match: { status: 'rewarded', ...match } },
      {
        $group: {
          _id: null,
          total: { $sum: { $add: ['$referrerCreditAmount', '$refereeCreditAmount'] } },
        },
      },
    ]);
    return agg?.total ?? 0;
  }

  /**
   * Indian financial year bounds for `now`: Apr 1 (inclusive) -> next Apr 1
   * (exclusive). A date in Jan-Mar belongs to the FY that started the PREVIOUS
   * April. Used for the per-user annual credit ceiling (194R guard).
   */
  private indianFinancialYearBounds(now: Date): { start: Date; end: Date } {
    // Built in UTC so the [start, end) window aligns with the UTC `rewardedAt`
    // timestamps; a local-time `new Date(y, 3, 1)` would skew the FY boundary by
    // the server's TZ offset at the Apr-1 cutover.
    const y = now.getUTCFullYear();
    const startYear = now.getUTCMonth() >= 3 ? y : y - 1; // month 3 === April (0-based).
    return {
      start: new Date(Date.UTC(startYear, 3, 1)), // Apr 1, startYear (UTC).
      end: new Date(Date.UTC(startYear + 1, 3, 1)), // Apr 1, startYear + 1 (exclusive, UTC).
    };
  }

  /**
   * Build the caller's referral summary for `GET /connect/referrals/me`.
   *
   * What: ensures the caller has a code (via getOrCreateMyCode), then aggregates
   *   their referral counts + earned/pending credit and the most recent referred
   *   people. `creditsEarned` = Σ rewarded `referrerCreditAmount`; `creditsPending`
   *   = Σ qualified-not-yet-rewarded `referrerCreditAmount`.
   * Cross-module: joins the referee `User` (name/handle) for the `recent` list.
   * Watch: `enabled` mirrors the live config so the web can render the dark/disabled
   *   state; counts always reflect this referrer only.
   */
  async getMyReferralSummary(userId: string): Promise<{
    code: string;
    enabled: boolean;
    referrerCredits: number;
    refereeCredits: number;
    referredCount: number;
    rewardedCount: number;
    pendingCount: number;
    creditsEarned: number;
    creditsPending: number;
    recent: { name: string; status: ReferralStatus; date: Date | null }[];
  }> {
    const cfg = await this.configService.getConfig();
    const code = await this.getOrCreateMyCode(userId);
    const referrerId = new Types.ObjectId(userId);

    const [referredCount, rewardedCount, pendingCount, creditsEarned, creditsPending, recent] =
      await Promise.all([
        // Total people this user referred (any non-rejected lifecycle state counts as
        // "referred"; rejected rows are excluded so the headline number is honest).
        this.referralModel.countDocuments({
          referrerUserId: referrerId,
          status: { $ne: 'rejected' },
        }),
        this.referralModel.countDocuments({ referrerUserId: referrerId, status: 'rewarded' }),
        // "Pending" to the user = earned-but-on-hold (qualified) -- the credit is
        // coming but not yet spendable.
        this.referralModel.countDocuments({ referrerUserId: referrerId, status: 'qualified' }),
        this.sumRewardedCredit({ referrerUserId: referrerId }),
        this.sumReferrerCreditByStatus(referrerId, 'qualified'),
        this.referralModel
          .find({ referrerUserId: referrerId })
          .sort({ createdAt: -1 })
          .limit(20)
          .select('refereeUserId status createdAt qualifiedAt rewardedAt')
          .lean<
            {
              refereeUserId: Types.ObjectId;
              status: ReferralStatus;
              createdAt?: Date;
              qualifiedAt?: Date;
              rewardedAt?: Date;
            }[]
          >()
          .exec(),
      ]);

    // Join referee names for the recent list (one batched lookup, name/handle only).
    const refereeIds = recent.map((r) => r.refereeUserId);
    const users = refereeIds.length
      ? await this.userModel
          .find({ _id: { $in: refereeIds } })
          .select('name handle')
          .lean<{ _id: Types.ObjectId; name?: string; handle?: string | null }[]>()
          .exec()
      : [];
    const nameById = new Map(
      users.map((u) => [String(u._id), (u.name || u.handle || 'Member').trim() || 'Member']),
    );

    const recentView = recent.map((r) => ({
      name: nameById.get(String(r.refereeUserId)) ?? 'Member',
      status: r.status,
      // The most meaningful date for the row's current state.
      date: r.rewardedAt ?? r.qualifiedAt ?? r.createdAt ?? null,
    }));

    return {
      code,
      enabled: cfg.enabled,
      referrerCredits: cfg.referrerCredits,
      refereeCredits: cfg.refereeCredits,
      referredCount,
      rewardedCount,
      pendingCount,
      creditsEarned,
      creditsPending,
      recent: recentView,
    };
  }

  /** Σ `referrerCreditAmount` for this referrer over rows in a given status. */
  private async sumReferrerCreditByStatus(
    referrerUserId: Types.ObjectId,
    status: ReferralStatus,
  ): Promise<number> {
    const [agg] = await this.referralModel.aggregate<{ total: number }>([
      { $match: { referrerUserId, status } },
      { $group: { _id: null, total: { $sum: '$referrerCreditAmount' } } },
    ]);
    return agg?.total ?? 0;
  }

  /**
   * Admin log: paginated referral rows, newest first, optionally filtered by
   * status and/or referrer. Returns rows + total for the admin table.
   * Cross-module: surfaced by the referral-admin controller (Phase 5).
   */
  async listReferrals(params: {
    status?: ReferralStatus;
    referrerUserId?: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: ConnectReferralDocument[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.floor(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize) || 25));

    const filter: Record<string, unknown> = {};
    if (params.status) filter.status = params.status;
    if (params.referrerUserId && Types.ObjectId.isValid(params.referrerUserId)) {
      filter.referrerUserId = new Types.ObjectId(params.referrerUserId);
    }

    const [rows, total] = await Promise.all([
      this.referralModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.referralModel.countDocuments(filter),
    ]);

    return { rows, total, page, pageSize };
  }

  /**
   * Admin clawback of a single referral. REVERSES each credited side independently
   * via WalletService.adjust (a signed NEGATIVE adjustment of the exact credited
   * amount), then ALWAYS marks the row `rejected` / `manual_clawback` and audits.
   *
   * Money correctness (per-side, tolerant + idempotent):
   *   - A side is reversed ONLY when it was actually credited (`...LedgerId` set AND
   *     amount > 0) AND not already clawed back (`!...ClawedBack`). Each side's
   *     reversal is wrapped in its own try/catch:
   *       * success            -> set that side's `...ClawedBack = true`.
   *       * already-spent       -> `wallet.adjust` floors the balance at 0 and throws
   *         `BadRequestException`; we CATCH it, warn + Sentry-tag, set `...ClawedBack`
   *         true anyway (the credit was already drained -- we did what we could), and
   *         CONTINUE without aborting the other side or the flip.
   *       * any other error     -> rethrow (a genuine fault, e.g. mongo down).
   *   - The `...ClawedBack` booleans make a RETRY a no-op for already-handled sides:
   *     a second clawback (or a re-run on a now-`rejected` row) issues NO further
   *     `wallet.adjust` calls, so a reversal can never be applied twice (no
   *     double-debit).
   *   - A NON-rewarded row (pending/qualified) has no live credits (no ledger ids),
   *     so no side reverses -- it is flipped + audited only.
   *
   * Cross-module: WalletService.adjust(ownerUserId, amount, adminUserId, reason, note?)
   *   -- amount is SIGNED (negative here); reason is 'referral clawback'. AuditService
   *   logs a `referral_clawback` event under AppModule.ADS; `meta` records which sides
   *   were reversed vs skipped-as-already-spent.
   */
  async clawback(
    referralId: string,
    reason: string,
    adminUserId: string,
  ): Promise<ConnectReferralDocument> {
    const row = await this.referralModel.findById(referralId).exec();
    if (!row) {
      throw new Error(`referral ${referralId} not found`);
    }

    // Per-side reversal, each independent + tolerant. `reverseSide` attempts the
    // wallet.adjust ONLY when the side was credited and not already clawed back;
    // it returns true when a NEW reversal actually landed (false when skipped,
    // already-handled, or the credit was already spent). The boolean guards make a
    // retry a no-op so a reversal is never applied twice.
    // CN-REF-1: each side is now CLAIMED durably inside reverseSide before its
    // money moves, so clawback() no longer depends on this final save() to
    // persist the ClawedBack flags (they are committed by their own atomic claim).
    // If the second reverseSide throws a genuine fault, the first side's claim +
    // reversal are already durable, and a retry will not re-debit it.
    const referrerReversed = await this.reverseSide(row, 'referrer', adminUserId);
    const refereeReversed = await this.reverseSide(row, 'referee', adminUserId);

    // ALWAYS flip + audit, regardless of which sides reversed vs were already spent.
    // Setting status:'rejected' twice (on a retry) is idempotent + harmless.
    row.status = 'rejected';
    row.rejectionReason = 'manual_clawback';
    await row.save();

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'ConnectReferral',
      action: 'referral_clawback',
      actorId: adminUserId,
      entityId: referralId,
      meta: { reason, referrerReversed, refereeReversed },
    });

    return row;
  }

  /**
   * Reverse ONE side of a clawback (referrer or referee). Tolerant + idempotent:
   *  - Skips (returns false) when the side was never credited (no ledger id / amount
   *    <= 0) or has already been clawed back (`...ClawedBack` true) -- so a retry
   *    issues no second wallet.adjust and can never double-debit.
   *  - On a successful reversal sets `...ClawedBack = true` and returns true.
   *  - On the already-spent `BadRequestException` (wallet floored the balance and
   *    rejected the debit) it warns + Sentry-tags, sets `...ClawedBack = true` anyway
   *    (the credit was already drained -- nothing left to pull back), and returns
   *    false (no NEW money moved). The clawback still proceeds.
   *  - Any OTHER error is rethrown (a genuine fault must not be silently swallowed).
   */
  private async reverseSide(
    row: ConnectReferralDocument,
    side: 'referrer' | 'referee',
    adminUserId: string,
  ): Promise<boolean> {
    const ledgerId = side === 'referrer' ? row.referrerLedgerId : row.refereeLedgerId;
    const amount = side === 'referrer' ? row.referrerCreditAmount : row.refereeCreditAmount;
    const ownerUserId = side === 'referrer' ? row.referrerUserId : row.refereeUserId;
    const clawedField = side === 'referrer' ? 'referrerClawedBack' : 'refereeClawedBack';

    // Nothing to reverse: never credited or zero amount.
    if (!ledgerId || !(amount > 0)) return false;

    // CN-REF-1 (Bucket 3) — CLAIM-BEFORE-MOVE (mirrors WalletService.debit's own
    // ordered-writes pattern). Atomically claim this side by flipping its
    // `...ClawedBack` flag from unset to true in a SINGLE conditional write BEFORE
    // touching money. A miss (null result) means the flag was already set (a prior
    // run, or a concurrent clawback) -> another call owns this side, so skip with
    // no wallet.adjust (never double-debit). The claim is DURABLE the instant it
    // commits, so even if wallet.adjust below throws a genuine fault and aborts
    // the whole clawback(), a retry sees the flag set and never re-debits this
    // side. This trades "might under-clawback on a rare crash between claim and
    // adjust" for "can never double-debit" -- the correct direction for money
    // (same philosophy as debit()'s documented under-charge safety).
    const claim = await this.referralModel
      .findOneAndUpdate(
        { _id: row._id, [clawedField]: { $ne: true } },
        { $set: { [clawedField]: true } },
        { new: true },
      )
      .exec();
    if (!claim) return false; // already claimed by another call -> no double-debit.
    // Keep the in-memory doc in step so the caller's later save() does not
    // resurrect the pre-claim value.
    if (side === 'referrer') row.referrerClawedBack = true;
    else row.refereeClawedBack = true;

    try {
      await this.wallet.adjust(
        String(ownerUserId),
        -amount,
        adminUserId,
        'referral clawback',
        `referral:${String(row._id)}:${side}`,
      );
      return true;
    } catch (err) {
      // Already-spent credit: the wallet floors the balance at 0 and rejects the
      // debit. The claim STAYS true (we intentionally keep the "tried once"
      // marker -- same behaviour as before, just now durable from the claim, not
      // from the end of clawback()). Nothing left to pull back; the clawback
      // still proceeds. Returns false (no NEW money moved).
      if (err instanceof BadRequestException) {
        this.logger.warn(
          `clawback could not reverse ${side} of referral ${String(row._id)} ` +
            `(credit likely already spent): ${err.message}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'connect.referral', op: 'clawbackReverse', side },
        });
        return false;
      }
      // Genuine fault (e.g. mongo down): the claim is ALREADY persisted (step
      // above committed), so a retry sees the flag set and skips this side rather
      // than re-attempting a debit that may or may not have landed. Log + Sentry
      // so an operator can manually reconcile this rare "claimed but adjust threw
      // a non-BadRequest error" case (the reconcile cron's drift detection is the
      // template; a dedicated auto-reconciler for this is a deferred follow-on).
      this.logger.error(
        `clawback CLAIMED ${side} of referral ${String(row._id)} but wallet.adjust ` +
          `threw a non-BadRequest fault -- manual reconcile needed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'connect.referral', op: 'clawbackReverseClaimedButFailed', side },
      });
      throw err;
    }
  }

  /**
   * True when the email's domain is a known disposable / throwaway provider.
   * Case-insensitive exact host match. Empty/invalid email -> false (no email is
   * not a fraud signal on its own; mobile is OTP-verified at signup anyway).
   */
  private isDisposableEmail(email?: string | null): boolean {
    if (!email) return false;
    const at = email.lastIndexOf('@');
    if (at < 0) return false;
    const domain = email
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (!domain) return false;
    return DISPOSABLE_EMAIL_DOMAINS.has(domain);
  }

  /** Mongo duplicate-key (E11000) detection across driver shapes. */
  private isDuplicateKeyError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: number }).code;
    return code === 11000;
  }
}
