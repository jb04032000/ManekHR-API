import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../common/redis/redis.module';

@Injectable()
export class IdempotencyService {
  private readonly TTL_SECONDS = 86400; // 24h

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(scope: string, idempotencyKey: string): string {
    return `idem:${scope}:${idempotencyKey}`;
  }

  async getCached<T>(scope: string, key: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(scope, key));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async store<T>(scope: string, key: string, payload: T): Promise<void> {
    await this.redis.setex(this.key(scope, key), this.TTL_SECONDS, JSON.stringify(payload));
  }

  /**
   * Atomic Redis SET NX EX distributed lock — prevents concurrent requests with the
   * same idempotency key from both passing the cache-miss check and double-posting.
   * Returns true if the lock was acquired; false if another request already holds it.
   */
  async tryAcquireLock(scope: string, key: string, ttlSeconds = 120): Promise<boolean> {
    const result = await this.redis.set(
      `lock:${scope}:${key}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}
