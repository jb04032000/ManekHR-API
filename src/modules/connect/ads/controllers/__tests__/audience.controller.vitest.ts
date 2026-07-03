/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * AudienceController unit tests -- TDD.
 */

import { describe, it, expect, vi } from 'vitest';
import { AudienceController } from '../audience.controller';

function makeMockAudienceService() {
  return {
    estimate: vi.fn().mockResolvedValue({ reach: 1200, belowFloor: false }),
  };
}

const FULL_TARGETING = {
  roles: ['karigar'],
  sectors: ['textile'],
  districts: ['surat'],
  companySizes: ['small'],
};

describe('AudienceController', () => {
  describe('POST /estimate', () => {
    it('calls audienceService.estimate with the targeting spec from dto', async () => {
      const svc = makeMockAudienceService();
      const ctrl = new AudienceController(svc as any);
      const dto = { targeting: FULL_TARGETING };

      await ctrl.estimate(dto);

      expect(svc.estimate).toHaveBeenCalledWith(FULL_TARGETING);
    });

    it('defaults targeting to an empty spec when dto.targeting is undefined', async () => {
      const svc = makeMockAudienceService();
      const ctrl = new AudienceController(svc as any);
      const dto = {};

      await ctrl.estimate(dto);

      expect(svc.estimate).toHaveBeenCalledWith({
        roles: [],
        sectors: [],
        districts: [],
        companySizes: [],
      });
    });

    it('returns the estimate result from the service', async () => {
      const svc = makeMockAudienceService();
      const ctrl = new AudienceController(svc as any);

      const result = await ctrl.estimate({ targeting: FULL_TARGETING });

      expect(result).toEqual({ reach: 1200, belowFloor: false });
    });
  });
});
