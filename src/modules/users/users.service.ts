import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { User } from './schemas/user.schema';
import { UserClaimsCacheService } from './user-claims-cache.service';
import { normaliseIndianMobile } from '../auth/utils/mobile-normalizer';
import { APP_LOCK_IDLE_PRESETS_MS } from './dto/set-app-lock-idle.dto';
import {
  HANDLE_MAX_LEN,
  RESERVED_HANDLES,
  slugifyName,
  validateHandleFormat,
} from './utils/handle.util';

/**
 * Result of an availability check. `taken` and `reserved` are caller-facing
 * — surface inline error copy. `format` should rarely fire from the UI (the
 * client validates the format first); reserved as a backend belt-and-braces.
 */
export type HandleAvailability =
  | { available: true }
  | { available: false; reason: 'format' | 'reserved' | 'taken' };

/** Cooldown between user-initiated handle changes — 30 days. */
const HANDLE_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  /**
   * User fields cached on the JWT hot path (OQ-2). Any write touching one of
   * these must invalidate the per-user claims cache so `JwtStrategy.validate()`
   * does not serve stale `isAdmin` / `isActive` / `email` / `mobile`.
   */
  private static readonly CACHED_CLAIM_FIELDS: ReadonlyArray<keyof User> = [
    'email',
    'mobile',
    'isAdmin',
    'isActive',
  ];

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly claimsCache: UserClaimsCacheService,
  ) {}

  /**
   * Build the `$or` clause that resolves a user identifier (typed by the
   * caller) to a stored User row. Mobile-shape inputs are matched against
   * BOTH the canonical `91XXXXXXXXXX` form (how SmsOtpService persists new
   * registrations) and the bare `XXXXXXXXXX` form (legacy rows registered
   * before the E.164 normalisation landed). Email-shape inputs fall through
   * to an exact `email` match.
   *
   * Single source of truth so login / forgot / invite / register-existence
   * lookups all stay in lockstep with the SMS-OTP write path.
   */
  private buildIdentifierOr(identifier: string): FilterQuery<User>[] {
    const norm = normaliseIndianMobile(identifier);
    if (norm) {
      const mobiles = [norm.full];
      if (norm.bare !== norm.full) mobiles.push(norm.bare);
      return [{ mobile: { $in: mobiles } }];
    }
    return [{ email: identifier }, { mobile: identifier }];
  }

  async findById(id: string): Promise<User | null> {
    return this.userModel.findById(id).exec();
  }

  async findByIdWithCredentials(id: string): Promise<User | null> {
    return this.userModel
      .findById(id)
      .select('+passwordHash +emailVerificationToken +pinHash')
      .exec();
  }

  async findByIdWithEmailToken(id: string): Promise<User | null> {
    return this.userModel.findById(id).select('+emailVerificationToken').exec();
  }

  async findByIdWithPinFields(id: string): Promise<User | null> {
    return this.userModel.findById(id).select('+pinHash +pinAttempts +pinLockedUntil').exec();
  }

  async findByIdWithPasswordAndPin(id: string): Promise<User | null> {
    return this.userModel
      .findById(id)
      .select('+passwordHash +pinHash +pinAttempts +pinLockedUntil')
      .exec();
  }

  async findByIdWithMobileOtpFields(id: string): Promise<User | null> {
    return this.userModel
      .findById(id)
      .select(
        '+mobileVerificationToken +mobileVerificationExpiresAt +mobileOtpAttempts +mobileOtpLockedUntil +mobileOtpLastSentAt +mobileVerificationFlow',
      )
      .exec();
  }

  async findByMobile(mobile: string): Promise<User | null> {
    // Match either the normalised "919876543210" form or the bare 10-digit
    // legacy form some accounts were created with before SMS-OTP normalisation.
    const bare = mobile.replace(/^91/, '');
    return this.userModel.findOne({ $or: [{ mobile }, { mobile: bare }] }).exec();
  }

  async findByMobileWithMobileOtpFields(mobile: string): Promise<User | null> {
    const bare = mobile.replace(/^91/, '');
    return this.userModel
      .findOne({ $or: [{ mobile }, { mobile: bare }] })
      .select(
        '+passwordHash +mobileVerificationToken +mobileVerificationExpiresAt +mobileOtpAttempts +mobileOtpLockedUntil +mobileOtpLastSentAt +mobileVerificationFlow',
      )
      .exec();
  }

  async findByIdentifier(identifier: string): Promise<User | null> {
    return this.userModel.findOne({ $or: this.buildIdentifierOr(identifier) }).exec();
  }

  async findByIdentifierWithCredentials(identifier: string): Promise<User | null> {
    return this.userModel
      .findOne({ $or: this.buildIdentifierOr(identifier) })
      .select('+passwordHash +pinHash')
      .exec();
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.userModel.findOne({ googleId }).exec();
  }

  async findByInviteeIdentifier(identifier: string): Promise<User | null> {
    return this.userModel
      .findOne({
        $or: this.buildIdentifierOr(identifier),
        isActive: true,
      })
      .exec();
  }

  async create(userDto: Partial<User>): Promise<User> {
    if (!userDto.email && !userDto.mobile) {
      throw new BadRequestException('Either email or mobile must be provided');
    }
    const createdUser = new this.userModel(userDto);
    return createdUser.save();
  }

  async findOneByFilter(filter: FilterQuery<User>): Promise<User | null> {
    return this.userModel.findOne(filter).exec();
  }

  async update(id: string, updateDto: Partial<User>): Promise<User> {
    const updated = await this.userModel
      .findByIdAndUpdate(id, { $set: updateDto }, { returnDocument: 'after' })
      .exec();
    // OQ-2: invalidate the JWT hot-path cache when this write changed any
    // cached claim (isAdmin grant/revoke, isActive flip, email/mobile change).
    // Cheap no-op when the patch touches only non-cached fields (e.g. pinHash).
    if (UsersService.CACHED_CLAIM_FIELDS.some((f) => f in updateDto)) {
      await this.claimsCache.invalidate(id);
    }
    return updated;
  }

  /**
   * Atomically claim a mobile number for the given user, marking it verified
   * and clearing any pending OTP state. The unique index on `mobile` is the
   * race-safety primitive: if another user has already verified this number
   * during the OTP window, Mongo returns E11000 and we surface
   * `MOBILE_TAKEN_DURING_VERIFY` so the caller can re-prompt with a fresh
   * candidate.
   */
  async claimMobileVerified(userId: string, mobileFull: string): Promise<User> {
    try {
      const updated = await this.userModel
        .findByIdAndUpdate(
          userId,
          {
            $set: {
              mobile: mobileFull,
              isMobileVerified: true,
              mobileVerificationToken: null,
              mobileVerificationExpiresAt: null,
              mobileOtpAttempts: 0,
              mobileOtpLockedUntil: null,
              mobileVerificationFlow: null,
            },
          },
          { returnDocument: 'after', runValidators: true },
        )
        .exec();
      if (!updated) throw new BadRequestException('Account not found.');
      // OQ-2: mobile changed -> drop the JWT hot-path cache for this user.
      await this.claimsCache.invalidate(userId);
      return updated;
    } catch (err) {
      const dupErr = err as { code?: number; errorResponse?: { code?: number } };
      if (dupErr?.code === 11000 || dupErr?.errorResponse?.code === 11000) {
        throw new ConflictException({
          code: 'MOBILE_TAKEN_DURING_VERIFY',
          message:
            'This mobile number was just claimed by another account. Please use a different one.',
        });
      }
      throw err;
    }
  }

  /**
   * Atomically claim an email for the given user, marking it verified and
   * clearing any pending OTP state. Mirrors `claimMobileVerified`.
   */
  async claimEmailVerified(userId: string, email: string): Promise<User> {
    try {
      const updated = await this.userModel
        .findByIdAndUpdate(
          userId,
          {
            $set: {
              email,
              isEmailVerified: true,
              emailVerificationToken: null,
            },
          },
          { returnDocument: 'after', runValidators: true },
        )
        .exec();
      if (!updated) throw new BadRequestException('Account not found.');
      // OQ-2: email changed -> drop the JWT hot-path cache for this user.
      await this.claimsCache.invalidate(userId);
      return updated;
    } catch (err) {
      const dupErr = err as { code?: number; errorResponse?: { code?: number } };
      if (dupErr?.code === 11000 || dupErr?.errorResponse?.code === 11000) {
        throw new ConflictException({
          code: 'EMAIL_TAKEN_DURING_VERIFY',
          message: 'This email was just claimed by another account. Please use a different one.',
        });
      }
      throw err;
    }
  }

  /**
   * Hard-delete a User row. Used as a compensating action by
   * SmsOtpService.verifyOtp when Workspace creation fails immediately after
   * User creation in the web combined-signup flow — keeps the database from
   * carrying an orphan account that the user cannot finish setting up.
   * Caller must clean up dependent rows (subscriptions, sessions) themselves
   * if any have been created at the time of compensation.
   */
  async remove(id: string): Promise<void> {
    await this.userModel.findByIdAndDelete(id).exec();
  }

  /**
   * Load all users that have a non-null `resetPasswordTokenHash` and a
   * future `resetPasswordExpiresAt`. Consumed by `AuthService.resetPassword`
   * which bcrypt-compares the incoming raw token against each candidate's
   * stored hash to find the owner without ever storing the raw token.
   *
   * Pending-reset rows are short-lived (15-min expiry) and bounded — bcrypt
   * compare across them is fine at MVP scale. If the candidate set ever
   * grows, switch to an indexed sha256 lookup before the bcrypt-compare.
   */
  async findManyWithResetTokenAndExpiry(): Promise<User[]> {
    return this.userModel
      .find({
        resetPasswordTokenHash: { $ne: null },
        resetPasswordExpiresAt: { $gt: new Date() },
      })
      .select('+resetPasswordTokenHash +resetPasswordExpiresAt')
      .exec();
  }

  /**
   * Legacy single-token push registration. New clients should call
   * `POST /api/devices/register` (UserDevicesModule) which supports multiple
   * devices per user and prunes dead tokens automatically. This helper is
   * retained so the existing `PATCH /api/users/profile/fcm-token` endpoint
   * continues to function for older mobile builds in the wild.
   */
  async updateFcmToken(id: string, fcmToken: string): Promise<void> {
    await this.userModel
      .findByIdAndUpdate(id, {
        $set: { fcmToken, fcmTokenUpdatedAt: new Date() },
      })
      .exec();
  }

  /**
   * ERP policy-consent state for a user — `erpPolicyAccepted` is true once
   * `erpPolicyAcceptedAt` is stamped. Read by the ERP shell gate. Mirrors
   * `ConnectProfileService.getEntryState`'s policy read.
   */
  async getErpPolicyState(userId: string): Promise<{ erpPolicyAccepted: boolean }> {
    const user = await this.userModel
      .findById(userId)
      .select('erpPolicyAcceptedAt')
      .lean<{ erpPolicyAcceptedAt?: Date | null }>()
      .exec();
    return { erpPolicyAccepted: !!user?.erpPolicyAcceptedAt };
  }

  /**
   * Stamp the ERP policy/terms acceptance (idempotent — first write wins).
   * Mirrors `ConnectProfileService.acceptPolicy`.
   */
  async acceptErpPolicy(userId: string): Promise<{ acceptedAt: Date }> {
    const now = new Date();
    await this.userModel
      .updateOne(
        { _id: userId, erpPolicyAcceptedAt: { $in: [null, undefined] } },
        { $set: { erpPolicyAcceptedAt: now } },
      )
      .exec();
    const user = await this.userModel
      .findById(userId)
      .select('erpPolicyAcceptedAt')
      .lean<{ erpPolicyAcceptedAt?: Date | null }>()
      .exec();
    return { acceptedAt: user?.erpPolicyAcceptedAt ?? now };
  }

  /**
   * Record that the user dismissed a UI hint (idempotent — `$addToSet` will
   * not duplicate). Returns the updated `dismissedHints` list.
   */
  async dismissHint(userId: string, hint: string): Promise<{ dismissedHints: string[] }> {
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $addToSet: { dismissedHints: hint } },
        { returnDocument: 'after' },
      )
      .select('dismissedHints')
      .lean<{ dismissedHints?: string[] }>()
      .exec();
    return { dismissedHints: user?.dismissedHints ?? [] };
  }

  /**
   * Set or clear the caller's App Lock idle-timeout override (`null` clears it
   * so the per-workspace / env default applies). The DTO already validates the
   * incoming value against `APP_LOCK_IDLE_PRESETS_MS`; the second check here
   * is defensive (a non-DTO caller — internal service caller — cannot ship a
   * bogus number). Returns the resolved value for the client to merge into
   * its auth-store snapshot without a follow-up `/me` round-trip.
   */
  async setAppLockIdleMs(
    userId: string,
    value: number | null,
  ): Promise<{ appLockIdleMs: number | null }> {
    if (value !== null && !APP_LOCK_IDLE_PRESETS_MS.includes(value as never)) {
      throw new BadRequestException('Invalid App Lock idle preset.');
    }
    await this.userModel.updateOne({ _id: userId }, { $set: { appLockIdleMs: value } }).exec();
    return { appLockIdleMs: value };
  }

  /**
   * Lean read of the caller's personal App Lock idle override (`null` = none).
   * Used by `AuthService.resolveAppLockTtlSec` so the BE unlock TTL honours the
   * per-user override with the same precedence the web idle clock uses (user ->
   * workspace -> env). Kept cheap: a single projected field, no full document.
   * Pairs with `setAppLockIdleMs` (the writer) + `MeSecurityController`.
   */
  async getAppLockIdleMs(userId: string): Promise<number | null> {
    if (!Types.ObjectId.isValid(userId)) return null;
    const user = await this.userModel
      .findById(userId)
      .select('appLockIdleMs')
      .lean<{ appLockIdleMs?: number | null }>()
      .exec();
    return user?.appLockIdleMs ?? null;
  }

  // ── Profile slug ("handle") ─────────────────────────────────────────────

  /**
   * Check whether a candidate handle can be claimed. Validates format +
   * reserved-list first (cheap), then runs a case-insensitive uniqueness
   * lookup. Pass `excludeUserId` so a user can re-save their existing handle
   * without it reading as "taken by themselves".
   */
  async isHandleAvailable(value: string, excludeUserId?: string): Promise<HandleAvailability> {
    const fmt = validateHandleFormat(value);
    if (!fmt.ok) return { available: false, reason: fmt.reason };
    const filter: FilterQuery<User> = { handle: value };
    if (excludeUserId) filter._id = { $ne: new Types.ObjectId(excludeUserId) };
    const taken = await this.userModel
      .findOne(filter)
      .collation({ locale: 'en', strength: 2 })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    return taken ? { available: false, reason: 'taken' } : { available: true };
  }

  /**
   * Generate a handle for a user that doesn't have one yet (auto-called from
   * `auth.service` after each new-user creation). Idempotent — if the user
   * already has a handle, this is a no-op. Otherwise: slugify the name,
   * reserve-list fallback, collision-suffix loop, save.
   *
   * Best-effort: a failure must NOT block signup. The caller wraps in a
   * try/catch + logs; the user can set a handle later from the settings page.
   */
  async generateHandleForUser(userId: string): Promise<{ handle: string | null }> {
    const user = await this.userModel
      .findById(userId)
      .select('name handle')
      .lean<{ _id: Types.ObjectId; name?: string; handle?: string | null } | null>()
      .exec();
    if (!user) return { handle: null };
    if (user.handle) return { handle: user.handle };

    const base = this.buildHandleBase(user.name ?? '', user._id.toString());
    if (!base) return { handle: null }; // pure-non-Latin / nameless — defer to manual claim

    // Collision-suffix loop. Up to 50 attempts in practice — the chance of
    // more than a handful for a real signup is effectively zero, but the
    // loop bound prevents an unbounded retry if the DB is misbehaving.
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;
      if (candidate.length > HANDLE_MAX_LEN) continue; // overran the suffix; skip
      const avail = await this.isHandleAvailable(candidate, userId);
      if (!avail.available) continue;
      try {
        const updated = await this.userModel
          .findByIdAndUpdate(userId, { $set: { handle: candidate } }, { returnDocument: 'after' })
          .select('handle')
          .lean<{ handle?: string | null } | null>()
          .exec();
        if (updated?.handle) return { handle: updated.handle };
      } catch (err) {
        // E11000 means someone else just claimed this exact candidate in the
        // tiny window between availability + write — loop tries the next.
        const dupErr = err as { code?: number; errorResponse?: { code?: number } };
        if (dupErr?.code !== 11000 && dupErr?.errorResponse?.code !== 11000) {
          this.logger.warn(`generateHandleForUser ${userId}: ${(err as Error).message}`);
          throw err;
        }
      }
    }
    this.logger.warn(`generateHandleForUser ${userId}: exhausted attempts for base "${base}"`);
    return { handle: null };
  }

  /**
   * Claim a new handle for the caller (user-initiated change). Enforces:
   *  - format + reserved-list validation
   *  - case-insensitive uniqueness (excluding the caller themselves)
   *  - 30-day cooldown since the last manual claim (`handleChangedAt`)
   *
   * Stamps `handleChangedAt`. Returns the canonical (lowercased) handle so
   * the client can refresh its auth-store snapshot without re-fetching.
   *
   * Throws `BadRequestException` on format / reserved,
   * `ConflictException` on taken,
   * `ForbiddenException` on cooldown.
   */
  async claimHandle(
    userId: string,
    value: string,
  ): Promise<{ handle: string; handleChangedAt: Date }> {
    const normalized = value.trim().toLowerCase();
    const avail = await this.isHandleAvailable(normalized, userId);
    if (!avail.available) {
      if (avail.reason === 'format') {
        throw new BadRequestException({ code: 'HANDLE_INVALID_FORMAT' });
      }
      if (avail.reason === 'reserved') {
        throw new BadRequestException({ code: 'HANDLE_RESERVED' });
      }
      throw new ConflictException({ code: 'HANDLE_TAKEN' });
    }

    const existing = await this.userModel
      .findById(userId)
      .select('handle handleChangedAt')
      .lean<{ handle?: string | null; handleChangedAt?: Date | null } | null>()
      .exec();
    if (!existing) throw new BadRequestException('Account not found.');

    // No-op claim — user re-submitting their existing handle. Skip the
    // cooldown so the API stays idempotent.
    if (existing.handle === normalized) {
      return {
        handle: normalized,
        handleChangedAt: existing.handleChangedAt ?? new Date(0),
      };
    }

    if (existing.handleChangedAt) {
      const next = existing.handleChangedAt.getTime() + HANDLE_CHANGE_COOLDOWN_MS;
      if (Date.now() < next) {
        throw new ForbiddenException({
          code: 'HANDLE_COOLDOWN',
          nextChangeAt: new Date(next).toISOString(),
        });
      }
    }

    const now = new Date();
    try {
      const updated = await this.userModel
        .findByIdAndUpdate(
          userId,
          { $set: { handle: normalized, handleChangedAt: now } },
          { returnDocument: 'after' },
        )
        .select('handle handleChangedAt')
        .lean<{ handle?: string | null; handleChangedAt?: Date | null } | null>()
        .exec();
      return {
        handle: updated?.handle ?? normalized,
        handleChangedAt: updated?.handleChangedAt ?? now,
      };
    } catch (err) {
      const dupErr = err as { code?: number; errorResponse?: { code?: number } };
      if (dupErr?.code === 11000 || dupErr?.errorResponse?.code === 11000) {
        throw new ConflictException({ code: 'HANDLE_TAKEN' });
      }
      throw err;
    }
  }

  /**
   * Look up a user by their handle (case-insensitively). Returns the User
   * doc or null. Consumed by the public-profile resolver as the first leg of
   * the dual lookup (`handle → fall back to ObjectId`).
   */
  async findByHandle(handle: string): Promise<User | null> {
    return this.userModel
      .findOne({ handle: handle.toLowerCase() })
      .collation({ locale: 'en', strength: 2 })
      .exec();
  }

  /**
   * Internal — slugify a display name + apply the fallback rules. Returns an
   * empty string when no Latin chars are derivable; the caller skips the
   * auto-generation in that case (user must claim manually later).
   */
  private buildHandleBase(name: string, userIdHex: string): string {
    let base = slugifyName(name);
    if (!base) return '';
    // Pad short bases with a 4-char id suffix to satisfy min length without
    // colliding with other users named the same single short word.
    if (base.length < 4) {
      base = `${base}-${userIdHex.slice(-4)}`;
    }
    // Reserved bases ALWAYS get a `-u` suffix so the underlying word stays
    // available for the platform.
    if (RESERVED_HANDLES.has(base)) {
      base = `${base}-u`;
    }
    // Reserve 3 chars at the tail for the collision suffix (`-NN`).
    if (base.length > HANDLE_MAX_LEN - 3) {
      base = base.slice(0, HANDLE_MAX_LEN - 3).replace(/-+$/, '');
    }
    return base;
  }
}
