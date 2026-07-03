import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { MESSAGING_INITIATION_CAPS, type MessagingTier } from './messaging-limits';

/**
 * ManekHR Connect -- Inbox (Phase 7, I5) cold-DM-initiation rate limiter.
 *
 * A Redis token bucket per sender, consumed only when a brand-new DM thread is
 * created (cold outreach). The whole check is one atomic Lua script (read +
 * refill + conditional decrement + persist), so concurrent initiations cannot
 * over-spend the bucket. Keyed `inbox:rl:init:<userId>` (the global Redis client
 * already namespaces with `zari360:<env>:`).
 *
 * FAIL-OPEN: a Redis outage must never lock legitimate members out of starting
 * a conversation, so a script error allows the initiation (and is logged). The
 * durable abuse signals (reports, spam scoring in I5b) are the backstop.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed / 1000.0) * refill)
local allowed = 0
if tokens >= cost then allowed = 1; tokens = tokens - cost end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return allowed
`;

@Injectable()
export class MessagingRateLimiter {
  private readonly logger = new Logger('MessagingRateLimiter');

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Try to consume one cold-initiation token for `userId` at `tier`. Returns
   * `true` if allowed (token consumed), `false` if the bucket is empty.
   */
  async tryConsumeInitiation(
    userId: string,
    tier: MessagingTier,
    nowMs = Date.now(),
  ): Promise<boolean> {
    const cap = MESSAGING_INITIATION_CAPS[tier];
    const key = `inbox:rl:init:${userId}`;
    try {
      const allowed = await this.redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        String(cap.capacity),
        String(cap.refillPerSec),
        String(nowMs),
        String(cap.ttlSec),
        '1',
      );
      return Number(allowed) === 1;
    } catch (err) {
      this.logger.warn(`initiation rate-limit check failed (allowing): ${(err as Error).message}`);
      return true;
    }
  }
}
