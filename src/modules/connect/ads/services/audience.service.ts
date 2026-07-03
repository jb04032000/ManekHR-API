import { Injectable, Inject } from '@nestjs/common';
import type { TargetingMatchSpec } from '../lib/targeting';

// ---------------------------------------------------------------------------
// Injection token + collaborator interface
// ---------------------------------------------------------------------------

export const AUDIENCE_COUNTER = 'AUDIENCE_COUNTER';

export interface AudienceCounter {
  countMatching(spec: TargetingMatchSpec): Promise<number>;
}

// ---------------------------------------------------------------------------
// Privacy floor: never reveal that a segment has fewer than 50 reachable users.
// ---------------------------------------------------------------------------
export const AUDIENCE_FLOOR = 50;

@Injectable()
export class AudienceService {
  constructor(@Inject(AUDIENCE_COUNTER) private readonly counter: AudienceCounter) {}

  /**
   * Estimates the reachable audience for a targeting spec.
   *
   * If the raw count is below AUDIENCE_FLOOR the reach is clamped to
   * AUDIENCE_FLOOR and belowFloor is set to true (privacy protection - do
   * not leak small segment sizes to advertisers).
   */
  async estimate(spec: TargetingMatchSpec): Promise<{ reach: number; belowFloor: boolean }> {
    const n = await this.counter.countMatching(spec);
    if (n < AUDIENCE_FLOOR) {
      return { reach: AUDIENCE_FLOOR, belowFloor: true };
    }
    return { reach: n, belowFloor: false };
  }
}
