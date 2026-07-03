import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../common/redis/redis.module';
import type { AdProfile } from '../lib/targeting';

// ---------------------------------------------------------------------------
// Injection token + collaborator interface
// ---------------------------------------------------------------------------

export const AD_PROFILE_SOURCE = 'AD_PROFILE_SOURCE';

export interface AdProfileSource {
  buildFor(userId: string): Promise<AdProfile>;
}

// ---------------------------------------------------------------------------
// TTL for cached ad profiles (15 minutes).
// ---------------------------------------------------------------------------
const CACHE_TTL_SEC = 900;

@Injectable()
export class AdProfileService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AD_PROFILE_SOURCE) private readonly source: AdProfileSource,
  ) {}

  /**
   * Returns the AdProfile for a user, using a Redis cache with a 15-minute TTL.
   *
   * Cache key: adprofile:{userId}
   * - HIT: deserialise and return; source.buildFor is NOT called.
   * - MISS: call source.buildFor, write the result to Redis with EX 900, return.
   */
  async get(userId: string): Promise<AdProfile> {
    const key = `adprofile:${userId}`;
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as AdProfile;
    }
    const profile = await this.source.buildFor(userId);
    await this.redis.set(key, JSON.stringify(profile), 'EX', CACHE_TTL_SEC);
    return profile;
  }
}
