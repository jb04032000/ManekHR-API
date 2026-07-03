import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Wave 2 token revocation (W2.2 — 2026-05-10).
 *
 * Pushes (workspaceId, userId) tuples to a Redis denylist when a member is
 * removed, suspended, or has their role changed. RolesGuard checks the
 * denylist on every authenticated request and short-circuits with 403 when
 * a hit is found.
 *
 * Why Redis even though `WorkspaceMember.status='removed'` is already
 * checked in RolesGuard via `status: 'active'`?
 *
 *   1. **Strict revocation under replica lag.** A short-lived stale-read
 *      on a Mongo secondary could surface the previous active row briefly
 *      after removal. Redis is single-writer authoritative for the
 *      revocation window.
 *   2. **Role-change propagation.** On role-change we don't soft-delete the
 *      membership row, but we DO want to invalidate any in-flight session
 *      that resolved the old role server-side and is about to mutate. The
 *      denylist forces re-resolution on the next request.
 *   3. **Performance.** A single SET / GET avoids a workspace + member +
 *      role lookup on hot paths.
 *
 * TTL defaults to 24 hours — matches the longest reasonable access-token
 * expiry. The DB-backed soft-delete continues to enforce after the TTL
 * lapses, so this is a defense-in-depth layer, not a substitute.
 */
@Injectable()
export class WorkspaceRevocationService {
  private readonly logger = new Logger(WorkspaceRevocationService.name);
  private static readonly DEFAULT_TTL_SECONDS = 24 * 60 * 60;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(workspaceId: string, userId: string): string {
    return `revoke:ws:${workspaceId}:user:${userId}`;
  }

  /**
   * Mark (workspaceId, userId) as revoked. Subsequent RolesGuard checks
   * for this tuple return 403 until the TTL expires (or the underlying DB
   * row is restored AND the denylist key is cleared).
   *
   * Failures are logged but never thrown — revocation is fire-and-forget;
   * the DB-backed check (status='active') remains the source of truth.
   */
  async revoke(
    workspaceId: string,
    userId: string,
    ttlSeconds: number = WorkspaceRevocationService.DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    try {
      await this.redis.set(this.key(workspaceId, userId), '1', 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(
        `revoke failed for ws=${workspaceId} user=${userId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Returns true when (workspaceId, userId) is currently revoked. Returns
   * false on any Redis error to avoid hard-failing requests when Redis is
   * unavailable — the DB-backed `status: 'active'` check on the membership
   * still protects the resource.
   */
  async isRevoked(workspaceId: string, userId: string): Promise<boolean> {
    try {
      const value = await this.redis.get(this.key(workspaceId, userId));
      return value !== null;
    } catch (err) {
      this.logger.warn(
        `isRevoked check failed for ws=${workspaceId} user=${userId}: ${
          (err as Error)?.message ?? err
        }`,
      );
      return false;
    }
  }

  /**
   * Clear an existing revocation. Used when an owner re-grants access to a
   * previously removed member (lifecycle L8) — the new WorkspaceMember row
   * has status='active' but the denylist may still have a TTL-bound entry.
   */
  async clear(workspaceId: string, userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(workspaceId, userId));
    } catch (err) {
      this.logger.warn(
        `clear failed for ws=${workspaceId} user=${userId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
