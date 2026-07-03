import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/**
 * ManekHR Connect -- Inbox (Phase 7, I5b) spam-signal store + quarantine flag.
 *
 * The Redis-backed counters the (pure) `spam-scoring` consumes, plus the
 * auto-quarantine flag the initiation path enforces. Quarantine is a SOFT,
 * time-boxed Redis flag (not a durable ban): it lifts itself, and only blocks
 * starting NEW cold threads. Every method FAILS OPEN -- a Redis outage must
 * never wrongly quarantine or score a legitimate member.
 */
const DUPLICATE_WINDOW_SEC = 24 * 60 * 60;
const INITIATION_WINDOW_SEC = 24 * 60 * 60;
const QUARANTINE_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class MessagingSpamGuard {
  private readonly logger = new Logger('MessagingSpamGuard');

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** A short, collision-tolerant hash of a body (signal bucketing, not security). */
  private bodyHash(body: string): string {
    let h = 5381;
    const s = body.trim().toLowerCase();
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** Record this body for the sender and return how many times it was seen in the window. */
  async recordAndCountDuplicateBody(userId: string, body: string): Promise<number> {
    if (!body.trim()) return 1;
    const key = `inbox:spam:body:${userId}:${this.bodyHash(body)}`;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, DUPLICATE_WINDOW_SEC);
      return n;
    } catch (err) {
      this.logger.warn(`duplicate-body count failed: ${(err as Error).message}`);
      return 1;
    }
  }

  /** Increment the sender's cold-initiation counter for the window. */
  async recordInitiation(userId: string): Promise<void> {
    const key = `inbox:spam:init:${userId}`;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, INITIATION_WINDOW_SEC);
    } catch (err) {
      this.logger.warn(`initiation count failed: ${(err as Error).message}`);
    }
  }

  /** Read the sender's cold-initiation count without incrementing it. */
  async getInitiationCount(userId: string): Promise<number> {
    try {
      const raw = await this.redis.get(`inbox:spam:init:${userId}`);
      return raw ? Number(raw) || 0 : 0;
    } catch {
      return 0;
    }
  }

  async isQuarantined(userId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(`inbox:spam:quarantine:${userId}`)) === 1;
    } catch {
      return false; // fail open
    }
  }

  async quarantine(userId: string, ttlSec = QUARANTINE_TTL_SEC): Promise<void> {
    try {
      await this.redis.set(`inbox:spam:quarantine:${userId}`, '1', 'EX', ttlSec);
    } catch (err) {
      this.logger.warn(`quarantine set failed: ${(err as Error).message}`);
    }
  }
}
