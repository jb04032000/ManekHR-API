import { describe, it, expect, vi, type Mock } from 'vitest';

import { AudienceService, AUDIENCE_FLOOR } from '../services/audience.service';
import type { AudienceCounter } from '../services/audience.service';
import type { TargetingMatchSpec } from '../lib/targeting';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_SPEC: TargetingMatchSpec = {
  roles: ['manager'],
  sectors: ['textile'],
  districts: ['surat'],
  companySizes: ['50-200'],
  maxConnectionDegree: 2,
};

function makeFakeCounter(count: number): AudienceCounter {
  return {
    countMatching: vi.fn((_spec: TargetingMatchSpec): Promise<number> => Promise.resolve(count)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AudienceService', () => {
  describe('AUDIENCE_FLOOR constant', () => {
    it('is exported and equals 50', () => {
      expect(AUDIENCE_FLOOR).toBe(50);
    });
  });

  describe('estimate - above floor', () => {
    it('returns actual reach when count > AUDIENCE_FLOOR (count=200)', async () => {
      const counter = makeFakeCounter(200);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(200);
      expect(result.belowFloor).toBe(false);
    });

    it('returns actual reach when count = 100 (above floor)', async () => {
      const counter = makeFakeCounter(100);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(100);
      expect(result.belowFloor).toBe(false);
    });

    it('returns actual reach when count is exactly at floor (count=50, 50 < 50 is false)', async () => {
      const counter = makeFakeCounter(50);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(50);
      expect(result.belowFloor).toBe(false);
    });

    it('returns actual reach for large audience (count=10000)', async () => {
      const counter = makeFakeCounter(10000);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(10000);
      expect(result.belowFloor).toBe(false);
    });
  });

  describe('estimate - below floor', () => {
    it('returns AUDIENCE_FLOOR with belowFloor=true when count < AUDIENCE_FLOOR (count=30)', async () => {
      const counter = makeFakeCounter(30);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(AUDIENCE_FLOOR);
      expect(result.belowFloor).toBe(true);
    });

    it('returns AUDIENCE_FLOOR with belowFloor=true for count=49 (one below floor)', async () => {
      const counter = makeFakeCounter(49);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(50);
      expect(result.belowFloor).toBe(true);
    });

    it('returns AUDIENCE_FLOOR with belowFloor=true for count=0 (empty audience)', async () => {
      const counter = makeFakeCounter(0);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(50);
      expect(result.belowFloor).toBe(true);
    });

    it('returns AUDIENCE_FLOOR with belowFloor=true for count=1', async () => {
      const counter = makeFakeCounter(1);
      const svc = new AudienceService(counter);

      const result = await svc.estimate(SAMPLE_SPEC);

      expect(result.reach).toBe(50);
      expect(result.belowFloor).toBe(true);
    });
  });

  describe('estimate - passes spec to counter', () => {
    it('calls counter.countMatching with the exact spec provided', async () => {
      const counter = makeFakeCounter(200);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const countMatching = counter.countMatching as unknown as Mock;
      const svc = new AudienceService(counter);

      await svc.estimate(SAMPLE_SPEC);

      expect(countMatching).toHaveBeenCalledTimes(1);
      expect(countMatching).toHaveBeenCalledWith(SAMPLE_SPEC);
    });

    it('works with a broad spec (empty arrays = match-all)', async () => {
      const counter = makeFakeCounter(5000);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const countMatching = counter.countMatching as unknown as Mock;
      const svc = new AudienceService(counter);
      const broadSpec: TargetingMatchSpec = {
        roles: [],
        sectors: [],
        districts: [],
        companySizes: [],
      };

      const result = await svc.estimate(broadSpec);

      expect(result.reach).toBe(5000);
      expect(result.belowFloor).toBe(false);
      expect(countMatching).toHaveBeenCalledWith(broadSpec);
    });
  });
});
