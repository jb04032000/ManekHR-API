import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../common/redis/redis.module';
import type { PacingRepo } from './ad-decision.service';

/**
 * Redis-backed implementation of PacingRepo.
 *
 * Throttle state is stored as a simple presence key:
 *   pacing:{campaignId} -> '1' with TTL = ttlSec
 *
 * isThrottled returns true if the key exists (GET != null).
 * setThrottle writes the key with SET EX, which auto-expires after ttlSec.
 *
 * The PacingDaemon calls setThrottle(campaignId, 60) each minute for any
 * campaign that is over-pacing (lastMinute > target * 1.2). The TTL of 60s
 * means the throttle naturally releases on the next cron tick if the campaign
 * falls back within budget.
 */
@Injectable()
export class PacingRepoRedis implements PacingRepo {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isThrottled(campaignId: string): Promise<boolean> {
    return (await this.redis.get(`pacing:${campaignId}`)) !== null;
  }

  async setThrottle(campaignId: string, ttlSec: number): Promise<void> {
    await this.redis.set(`pacing:${campaignId}`, '1', 'EX', ttlSec);
  }
}
