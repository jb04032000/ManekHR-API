import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { env } from '../../config/env';

/**
 * The minimal user fields the JWT validation path needs on EVERY authenticated
 * request: `email`, `mobile`, `isAdmin`, plus `isActive` so a deactivated
 * user's still-valid token is rejected without a Mongo round-trip. Kept tiny on
 * purpose — this is hot-path data, not a full user projection.
 */
export interface CachedUserClaims {
  email?: string;
  mobile?: string;
  isAdmin: boolean;
  isActive: boolean;
}

/**
 * Short-lived Redis cache of the user fields the `JwtStrategy.validate()` hot
 * path reads on every authenticated request (OQ-2 hardening).
 *
 * WHY: before this, `JwtStrategy.validate()` did one `usersService.findById()`
 * Mongo round-trip per authenticated request (an N+1 at launch scale). The
 * owner approved caching those fields in Redis (the project already runs Redis)
 * with TTL = access-token lifetime, so a cache hit serves them without touching
 * Mongo. A miss falls back to Mongo and re-populates the cache.
 *
 * FRESHNESS: the cache is invalidated wherever the cached fields change —
 * `isAdmin` (admin grant/revoke + setup-admin), `isActive` (admin
 * deactivate/restore + account erasure), and `email`/`mobile` (verify/claim).
 * Even a missed invalidation self-heals within the cache TTL window (and the
 * refresh path always reads Mongo fresh on the `/auth/refresh` round-trip).
 *
 * TTL CEILING (AUTH-H1): the TTL is capped at 15 min (MAX_TTL_SEC) regardless of
 * the access-token lifetime. The deployed access-token lifetime is long (30d in
 * .env.example), so binding the cache TTL to it would let a single silently
 * failed `del` keep a deactivated/demoted user's stale `isAdmin`/`isActive`
 * claims for up to 30 days. Capping at 15 min bounds revocation-staleness to a
 * worst case of 15 min even if every invalidation on a user's write path were to
 * fail. This is independent of (and does NOT change) JWT_ACCESS_EXPIRY — the
 * access-token lifetime is a separate, broader decision.
 *
 * FAIL-OPEN ON REDIS ERROR: a cache read/write failure must never break auth —
 * the strategy falls back to the Mongo lookup. Mirrors the existing
 * fail-open denylist handling in JwtAuthGuard / refreshToken.
 *
 * Dependency note: written/read by `JwtStrategy`; invalidated by `UsersService`
 * (verify/claim/admin writes), `AuthService` (setup-admin), `AdminService`
 * (status change / erasure). Keyed under the global `zari360:<env>:` Redis
 * prefix (RedisModule), so the literal key is `auth:user-claims:<userId>`.
 */
@Injectable()
export class UserClaimsCacheService {
  private readonly logger = new Logger(UserClaimsCacheService.name);

  /**
   * Hard ceiling on the cache TTL (15 min), independent of the access-token
   * lifetime. See the class-level "TTL CEILING (AUTH-H1)" note: this bounds how
   * long a missed invalidation can serve stale admin/active claims.
   */
  private static readonly MAX_TTL_SEC = 900;

  /**
   * Effective TTL in seconds = min(access-token lifetime, MAX_TTL_SEC). The JWT
   * can't outlive the access-token window, and the 15-min ceiling caps
   * revocation-staleness regardless of how long that window is configured.
   * Parsed once from env at construction.
   */
  private readonly ttlSec: number;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    this.ttlSec = Math.min(this.parseAccessExpirySec(), UserClaimsCacheService.MAX_TTL_SEC);
  }

  private key(userId: string): string {
    return `auth:user-claims:${userId}`;
  }

  /** Read cached claims for a user, or null on miss / Redis error (fail-open). */
  async get(userId: string): Promise<CachedUserClaims | null> {
    try {
      const raw = await this.redis.get(this.key(userId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedUserClaims;
      // Defensive: a partially-written / legacy-shape entry is treated as a miss.
      if (typeof parsed?.isAdmin !== 'boolean' || typeof parsed?.isActive !== 'boolean') {
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.warn(
        `[UserClaimsCache] get failed for ${userId}, falling back to Mongo: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /** Cache claims for a user with TTL = access-token lifetime. Best-effort. */
  async set(userId: string, claims: CachedUserClaims): Promise<void> {
    try {
      await this.redis.set(this.key(userId), JSON.stringify(claims), 'EX', this.ttlSec);
    } catch (err) {
      this.logger.warn(
        `[UserClaimsCache] set failed for ${userId} (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Invalidate a user's cached claims. Call this on EVERY write path that
   * changes `isAdmin` / `isActive` / `email` / `mobile` so the next request
   * re-reads fresh from Mongo. Best-effort: a failed delete self-heals on TTL.
   */
  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId));
    } catch (err) {
      this.logger.warn(
        `[UserClaimsCache] invalidate failed for ${userId} (self-heals on TTL): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Parse `JWT_ACCESS_EXPIRY` (e.g. `15m`, `900s`, `1h`, `30d`) into seconds.
   * Falls back to 900s (15 min) on an unparseable value — the same default the
   * env loader uses. The raw value is a param (defaulting to env) so this is
   * unit-testable without mutating the singleton `env`. NOTE: the caller caps the
   * result at MAX_TTL_SEC (AUTH-H1); this only converts the configured string.
   */
  private parseAccessExpirySec(raw: string = env.jwt.accessExpiry || '15m'): number {
    const m = /^(\d+)\s*([smhd]?)$/.exec(raw.trim());
    if (!m) return 900;
    const value = parseInt(m[1], 10);
    const unit = m[2] || 's';
    const mult = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    const sec = value * mult;
    return Number.isFinite(sec) && sec > 0 ? sec : 900;
  }

  /**
   * Test/inspection seam: the effective TTL (seconds) handed to Redis on `set`.
   * Always <= MAX_TTL_SEC (AUTH-H1).
   */
  getTtlSecForTest(): number {
    return this.ttlSec;
  }
}
