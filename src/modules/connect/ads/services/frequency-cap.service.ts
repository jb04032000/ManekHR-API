import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../common/redis/redis.module';

@Injectable()
export class FrequencyCapService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Increments the hit counter for (userId, adSetId, windowSec) and returns
   * whether the caller is still within the cap.
   *
   * Key: freqcap:{userId}:{adSetId}:{windowSec}
   * On the first hit (n === 1) the key is given a TTL equal to windowSec so
   * it auto-expires and the window resets naturally.
   *
   * Returns true if the caller is within cap, false if the cap is exceeded.
   */
  async hitAndCheck(
    userId: string,
    adSetId: string,
    windowSec: number,
    cap: number,
  ): Promise<boolean> {
    const key = `freqcap:${userId}:${adSetId}:${windowSec}`;
    const n = await this.redis.incr(key);
    if (n === 1) {
      await this.redis.expire(key, windowSec);
    }
    return n <= cap;
  }
}
