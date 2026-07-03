import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, ClientSession, FilterQuery } from 'mongoose';
import * as crypto from 'crypto';
import { Session, SessionPlatform } from './schemas/session.schema';
import { TokenDenylist } from './schemas/token-denylist.schema';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsersService } from '../users/users.service';

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: SessionPlatform;
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionCountOptions {
  userId: string;
  platform?: SessionPlatform;
}

@Injectable()
export class SessionsService {
  private readonly JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

  /**
   * OQ-4: how long the session AUDIT row (device / IP / userAgent / lastActive
   * — Bucket D) is retained after the session is cleared. 1 year = the DPDP
   * traffic-log minimum. Decoupled from the 7-day JWT lifetime: the token-hash
   * (Bucket C) is cleared at expiry, but the forensic fields live a full year.
   */
  private readonly SESSION_AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

  constructor(
    @InjectModel(Session.name) private sessionModel: Model<Session>,
    @InjectModel(TokenDenylist.name)
    private tokenDenylistModel: Model<TokenDenylist>,
    private subscriptionsService: SubscriptionsService,
    private usersService: UsersService,
  ) {}

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async isTokenDenylisted(tokenHash: string): Promise<boolean> {
    const denylist = await this.tokenDenylistModel.findOne({ tokenHash }).exec();
    return !!denylist;
  }

  async createSession(
    userId: string,
    jwtToken: string,
    deviceInfo: DeviceInfo,
    dbSession?: ClientSession,
  ): Promise<Session> {
    const jwtTokenHash = this.hashToken(jwtToken);
    const userObjectId = new Types.ObjectId(userId);

    const subscription = await this.subscriptionsService.getUserSubscription(userId);

    const { platformLimit, totalLimit } = await this.getEffectiveSessionLimits(
      userId,
      subscription,
    );
    const platform = deviceInfo.platform;

    const platformCount = await this.countActiveSessions({
      userId,
      platform: platform,
    });
    const totalCount = await this.countActiveSessions({ userId });

    if (platformCount >= platformLimit || totalCount >= totalLimit) {
      const activeSessions = await this.getActiveSessions(userId);
      const exceeded = totalCount >= totalLimit ? 'total' : `${platform} platform`;
      const exceededLimit = totalCount >= totalLimit ? totalLimit : platformLimit;
      throw new ForbiddenException({
        message: `Maximum concurrent ${exceeded} sessions (${exceededLimit}) reached. Please logout from another device to continue.`,
        code: 'SESSION_LIMIT_REACHED',
        activeSessions: activeSessions.map((s) => ({
          id: s._id,
          deviceName: s.deviceName,
          platform: s.platform,
          lastActiveAt: s.lastActiveAt,
          location: s.location,
          isCurrentSession: false,
        })),
      });
    }

    const expiresAt = new Date(Date.now() + this.JWT_EXPIRY_SECONDS * 1000);

    const sessionData = {
      userId: userObjectId,
      jwtTokenHash,
      platform: deviceInfo.platform,
      deviceName: deviceInfo.deviceName,
      ipAddress: deviceInfo.ipAddress,
      userAgent: deviceInfo.userAgent,
      location: deviceInfo.ipAddress ? await this.resolveLocation(deviceInfo.ipAddress) : undefined,
      lastActiveAt: new Date(),
      expiresAt,
      isActive: true,
    };

    if (dbSession) {
      const [doc] = await this.sessionModel.create([sessionData], { session: dbSession });
      return doc;
    }
    return new this.sessionModel(sessionData).save();
  }

  /**
   * Create a session for a TOKEN REFRESH (rotation of an already-authenticated
   * session) — NOT a fresh login.
   *
   * `createSession` THROWS `SESSION_LIMIT_REACHED` at the cap so the FE
   * SessionLimitModal can ask the user to sign another device out. That is
   * correct for a login, but wrong for a refresh: failing a token rotation
   * would log out an actively-used session mid-work. So a refresh must never
   * reject — instead it EVICTS the oldest active session(s) on this platform so
   * the new rotated token fits inside the cap. This bounds the active-session
   * count to the limit even when a client fails to forward its rotated-out
   * access token (the primary balloon guard is that forward, which retires the
   * exact prior row in `AuthService.refreshToken`; this eviction is the backend
   * safety net so the count can never grow unbounded the way it did before).
   *
   * Because the precise prior row is normally already retired before this runs,
   * the eviction below is usually a no-op and only bites for legacy clients that
   * don't forward the old token.
   */
  async createSessionForRefresh(
    userId: string,
    jwtToken: string,
    deviceInfo: DeviceInfo,
  ): Promise<Session> {
    // Refresh delegates to the shared evict-oldest-then-create path so a token
    // rotation never rejects an actively-used session at the cap.
    return this.createSessionEvictingOldest(userId, jwtToken, deviceInfo);
  }

  /**
   * Create a session for an INTERACTIVE FRESH LOGIN (password login, Google
   * OAuth, OTP finalize, register).
   *
   * Behavioral decision (2026-06-14, owner-approved): a fresh login NEVER
   * throws `SESSION_LIMIT_REACHED`. Instead it EVICTS the oldest active
   * session(s) to make room — "newest device wins". Why: a returning owner on
   * a new device (their phone) was hard-blocked by `createSession`'s cap throw
   * while three stale web sessions (dev-server re-logins) held every slot.
   * Evicting the least-recently-active session is the same mechanism the
   * refresh path already uses, so the active-session count stays bounded by the
   * cap — it just stops rejecting the person trying to sign in.
   *
   * Side effect: the FE SessionLimitModal / `loginWithSessionTermination`
   * "choose which device to drop" flow no longer triggers on a normal login
   * (login now always succeeds). That explicit path is left intact but is
   * effectively dormant for the standard login surfaces. Keep in sync if the
   * product later wants the modal back for some tier.
   */
  async createSessionForLogin(
    userId: string,
    jwtToken: string,
    deviceInfo: DeviceInfo,
  ): Promise<Session> {
    return this.createSessionEvictingOldest(userId, jwtToken, deviceInfo);
  }

  /**
   * Shared "evict-oldest then create" path used by BOTH the refresh-rotation
   * and the interactive-login flows. Trims active sessions to (limit - 1) on
   * the per-platform AND the cross-platform caps so the row `createSession` is
   * about to insert lands exactly at the cap, never over it.
   */
  private async createSessionEvictingOldest(
    userId: string,
    jwtToken: string,
    deviceInfo: DeviceInfo,
  ): Promise<Session> {
    const subscription = await this.subscriptionsService.getUserSubscription(userId);
    const { platformLimit, totalLimit } = await this.getEffectiveSessionLimits(
      userId,
      subscription,
    );

    await this.evictOldestActiveSessions(
      userId,
      deviceInfo.platform,
      Math.max(0, platformLimit - 1),
    );
    await this.evictOldestActiveSessions(userId, undefined, Math.max(0, totalLimit - 1));

    // After the eviction above the count is below the cap, so createSession's
    // limit check passes and it will not throw.
    return this.createSession(userId, jwtToken, deviceInfo);
  }

  /**
   * Deactivate (and denylist) the oldest active sessions for a user until at
   * most `keep` remain, scoped to `platform` when provided (else all platforms).
   * "Oldest" = least-recently-active. Used by the refresh-rotation path to make
   * room within the concurrent-session cap without rejecting the refresh.
   */
  private async evictOldestActiveSessions(
    userId: string,
    platform: SessionPlatform | undefined,
    keep: number,
  ): Promise<void> {
    const query: FilterQuery<Session> = {
      userId: new Types.ObjectId(userId),
      isActive: true,
    };
    if (platform) query.platform = platform;

    const active = await this.sessionModel
      .find(query)
      .sort({ lastActiveAt: 1 }) // oldest first
      .exec();

    const excess = active.length - keep;
    if (excess <= 0) return;

    const toEvict = active.slice(0, excess);
    // Denylist each evicted token so a still-valid access token cannot keep
    // being used after its session row was retired (mirrors invalidateSession).
    await Promise.all(toEvict.map((s) => this.addToDenylist(s.jwtTokenHash, s.expiresAt)));
    await this.sessionModel.updateMany(
      { _id: { $in: toEvict.map((s) => s._id) } },
      { $set: { isActive: false } },
    );
  }

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- pre-existing weak typing on subscription schema; tracked separately */
  private async getEffectiveSessionLimits(
    userId: string,
    subscription: any,
  ): Promise<{ platformLimit: number; totalLimit: number }> {
    const user = await this.usersService.findById(userId);
    const userLimit = (user as any)?.sessionLimitOverride;

    if (userLimit !== null && userLimit !== undefined) {
      // Admin override applies to both caps (treated as the ceiling)
      return { platformLimit: userLimit, totalLimit: userLimit };
    }

    const entitlements = subscription?.planId?.entitlements || subscription?.appliedEntitlements;
    const platformLimit = entitlements?.maxSessionsPerPlatform || 3;
    const totalLimit = entitlements?.maxSessionsTotal || Math.max(platformLimit * 2, 5);
    return { platformLimit, totalLimit };
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */

  async countActiveSessions(options: SessionCountOptions): Promise<number> {
    await this.deactivateStaleSessionsForUser(options.userId);

    const query: FilterQuery<Session> = {
      userId: new Types.ObjectId(options.userId),
      isActive: true,
    };

    if (options.platform) {
      query.platform = options.platform;
    }

    return this.sessionModel.countDocuments(query).exec();
  }

  async getActiveSessions(userId: string): Promise<Session[]> {
    await this.deactivateStaleSessionsForUser(userId);

    return this.sessionModel
      .find({
        userId: new Types.ObjectId(userId),
        isActive: true,
      })
      .sort({ lastActiveAt: -1 })
      .exec();
  }

  /**
   * Self-heal stale "active" rows for a user before any session-count or
   * session-list operation. Catches orphan sessions left behind when
   * `revokeTokens` partially executed (e.g. Redis denylist write succeeded
   * but Mongo session-row update failed) AND any row whose absolute TTL
   * has passed without the cleanup cron running.
   *
   * Without this sweep, a half-completed logout would leave the row at
   * `isActive: true` and trip SESSION_LIMIT_REACHED on the next sign-in.
   */
  private async deactivateStaleSessionsForUser(userId: string): Promise<void> {
    const userObjectId = new Types.ObjectId(userId);
    const now = new Date();

    await this.sessionModel.updateMany(
      { userId: userObjectId, isActive: true, expiresAt: { $lt: now } },
      { $set: { isActive: false } },
    );

    const candidates = await this.sessionModel
      .find({ userId: userObjectId, isActive: true })
      .select('jwtTokenHash')
      .lean()
      .exec();

    if (!candidates.length) return;

    const hashes = candidates.map((s) => s.jwtTokenHash).filter(Boolean);
    if (!hashes.length) return;

    const denylisted = await this.tokenDenylistModel
      .find({ tokenHash: { $in: hashes } })
      .select('tokenHash')
      .lean()
      .exec();

    if (!denylisted.length) return;

    const denylistedHashes = denylisted.map((d) => d.tokenHash);
    await this.sessionModel.updateMany(
      {
        userId: userObjectId,
        isActive: true,
        jwtTokenHash: { $in: denylistedHashes },
      },
      { $set: { isActive: false } },
    );
  }

  async getActiveSessionsForAdmin(userId: string): Promise<Session[]> {
    // Mirror the user-side flow so admins don't see ghost rows that the
    // owning user no longer counts as active (orphaned by a partial revoke).
    await this.deactivateStaleSessionsForUser(userId);

    return this.sessionModel
      .find({
        userId: new Types.ObjectId(userId),
        isActive: true,
      })
      .sort({ lastActiveAt: -1 })
      .exec();
  }

  async updateLastActive(tokenHash: string): Promise<void> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const result = await this.sessionModel.updateOne(
      { jwtTokenHash: tokenHash, lastActiveAt: { $lt: fiveMinutesAgo } },
      { $set: { lastActiveAt: new Date() } },
    );

    if (result.modifiedCount > 0) {
      console.info(
        `[SessionActivity] Updated lastActiveAt for token hash: ${tokenHash.substring(0, 8)}...`,
      );
    }
  }

  async invalidateSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.sessionModel.findOne({
      _id: new Types.ObjectId(sessionId),
      userId: new Types.ObjectId(userId),
      isActive: true,
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    await this.addToDenylist(session.jwtTokenHash, session.expiresAt);

    await this.sessionModel.updateOne(
      {
        _id: new Types.ObjectId(sessionId),
        userId: new Types.ObjectId(userId),
      },
      { $set: { isActive: false } },
    );
  }

  async terminateAndCreate(
    userId: string,
    sessionIdToTerminate: string,
    newJwtToken: string,
    deviceInfo: DeviceInfo,
  ): Promise<Session> {
    const session = await this.sessionModel.findOne({
      _id: new Types.ObjectId(sessionIdToTerminate),
      userId: new Types.ObjectId(userId),
      isActive: true,
    });

    if (!session) {
      throw new NotFoundException('Session to terminate not found');
    }

    await this.addToDenylist(session.jwtTokenHash, session.expiresAt);

    await this.sessionModel.updateOne({ _id: session._id }, { $set: { isActive: false } });

    return this.createSession(userId, newJwtToken, deviceInfo);
  }

  async invalidateAllOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    const sessions = await this.sessionModel.find({
      userId: new Types.ObjectId(userId),
      _id: { $ne: new Types.ObjectId(currentSessionId) },
      isActive: true,
    });

    const tokenHashes = sessions.map((s) => s.jwtTokenHash);
    const expiresAt = sessions.map((s) => s.expiresAt);

    await Promise.all(tokenHashes.map((hash, i) => this.addToDenylist(hash, expiresAt[i])));

    const result = await this.sessionModel.updateMany(
      {
        userId: new Types.ObjectId(userId),
        _id: { $ne: new Types.ObjectId(currentSessionId) },
        isActive: true,
      },
      { $set: { isActive: false } },
    );
    return result.modifiedCount;
  }

  async invalidateAllSessions(userId: string): Promise<number> {
    const sessions = await this.sessionModel.find({
      userId: new Types.ObjectId(userId),
      isActive: true,
    });

    const tokenHashes = sessions.map((s) => s.jwtTokenHash);
    const expiresAt = sessions.map((s) => s.expiresAt);

    await Promise.all(tokenHashes.map((hash, i) => this.addToDenylist(hash, expiresAt[i])));

    const result = await this.sessionModel.updateMany(
      { userId: new Types.ObjectId(userId), isActive: true },
      { $set: { isActive: false } },
    );
    return result.modifiedCount;
  }

  async invalidateSessionByTokenHash(tokenHash: string, userId: string): Promise<void> {
    await this.addToDenylist(tokenHash);

    await this.sessionModel.updateOne(
      { jwtTokenHash: tokenHash, userId: new Types.ObjectId(userId) },
      { $set: { isActive: false } },
    );
  }

  private async addToDenylist(tokenHash: string, expiresAt?: Date): Promise<void> {
    const expiry = expiresAt || new Date(Date.now() + this.JWT_EXPIRY_SECONDS * 1000);

    // Surface failures: the caller (logout / session invalidation paths)
    // depends on this row reaching Mongo so the self-heal sweep + admin
    // surfaces correctly classify the session as revoked. A swallowed error
    // here lets a "logged-out" device keep showing as active on other
    // surfaces until the JWT TTL expires (up to 7 days).
    await this.tokenDenylistModel.findOneAndUpdate(
      { tokenHash },
      { tokenHash, expiresAt: expiry },
      { upsert: true },
    );
  }

  private async resolveLocation(ipAddress: string): Promise<string | undefined> {
    try {
      const geoip = (await import('geoip-lite')) as {
        lookup: (ip: string) => { city?: string; country?: string } | null | undefined;
      };
      const geo = geoip.lookup(ipAddress);
      if (geo) {
        const city = geo.city || '';
        const country = geo.country || '';
        const resolved = city && country ? `${city}, ${country}` : country || city;
        return resolved || undefined;
      }
    } catch (error) {
      console.warn(
        '[Sessions] GeoIP lookup failed (geoip-lite may not be installed):',
        (error as Error)?.message,
      );
    }
    // Don't fall back to the raw IP — the device list already shows IP in
    // its own column. Returning IP here duplicates the value and confuses
    // the user. Leave undefined so the UI shows "Unknown".
    return undefined;
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = new Date();
    const result = await this.sessionModel.updateMany(
      { expiresAt: { $lt: now }, isActive: true },
      { $set: { isActive: false } },
    );
    return result.modifiedCount;
  }

  /**
   * OQ-4 session-retention sweep (hourly, owned by SessionCleanupCron).
   *
   * For every CLEARED session (inactive OR past its JWT `expiresAt`) that does
   * not yet carry a `retainUntil`:
   *   - clear the transient `jwtTokenHash` (Bucket C — the token is dead; the
   *     hash is no longer needed and should not linger), and
   *   - stamp `retainUntil = now + 1 year` so the audit fields (Bucket D —
   *     device / IP / userAgent / lastActiveAt) are retained for the DPDP
   *     1-year traffic-log window, then auto-deleted by the `retainUntil` TTL
   *     index (replaces the old 7-day `expiresAt` TTL).
   *
   * Idempotent: only rows WITHOUT a `retainUntil` are touched, so a re-run is a
   * no-op. Live sessions (active AND unexpired) are never touched — their
   * `retainUntil` stays unset so the sparse TTL index ignores them entirely.
   * Returns the number of rows transitioned into the audit-retention window.
   *
   * Dependency note: the cleared `jwtTokenHash` means the denylist self-heal in
   * `deactivateStaleSessionsForUser` can no longer match these rows by hash —
   * which is correct, they are already `isActive:false` by the time the hash is
   * cleared. The Mongo `token_denylists` rows self-expire on their own TTL.
   */
  async applySessionRetention(): Promise<number> {
    const now = new Date();
    const retainUntil = new Date(now.getTime() + this.SESSION_AUDIT_RETENTION_MS);
    const result = await this.sessionModel.updateMany(
      {
        // A cleared session: explicitly revoked OR past its JWT lifetime.
        $or: [{ isActive: false }, { expiresAt: { $lt: now } }],
        // Not yet moved into the audit-retention window (idempotency guard).
        retainUntil: { $in: [null, undefined] },
      },
      {
        $set: {
          isActive: false,
          // Bucket C: the token hash is dead once the session is cleared.
          // Empty string (not unset) keeps the `required` schema constraint
          // satisfied while removing the live hash value.
          jwtTokenHash: '',
          // Bucket D: hold the forensic fields for the 1-year window.
          retainUntil,
        },
      },
    );
    return result.modifiedCount;
  }
}
