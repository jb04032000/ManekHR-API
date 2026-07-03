/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

/**
 * ConnectPricingConfigService unit tests.
 *
 * Proves the pricing-agility contract: defaults equal the previous hardcoded
 * values (moved, not changed), a runtime read reflects an admin write on the
 * next request (cache busted), and out-of-guardrail values are rejected. The
 * Mongo model + audit are in-process fakes; no real DB.
 */

vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConnectPricingConfigService } from '../connect-pricing-config.service';
import {
  CONNECT_PRICING_DEFAULTS,
  type ConnectPricingView,
} from '../../schemas/connect-pricing-config.schema';
import type { AdminPricingConfigDto } from '../../dto/admin-pricing-config.dto';

/**
 * Stateful fake of the singleton model. `findOneAndUpdate` with $setOnInsert
 * seeds defaults on first read; with $set applies the admin write. Mirrors the
 * real Mongoose upsert semantics the service relies on.
 */
function makeFakeModel() {
  let stored: Record<string, any> | null = null;
  const model = {
    findOneAndUpdate(_filter: any, update: any) {
      if (update.$set) {
        stored = { _id: 'cfg1', key: 'default', ...(stored ?? {}), ...update.$set };
      } else if (update.$setOnInsert && !stored) {
        stored = { _id: 'cfg1', ...update.$setOnInsert };
      }
      return { exec: () => Promise.resolve(stored) };
    },
    _peek: () => stored,
  };
  return model;
}

function makeAudit() {
  return { logEvent: vi.fn().mockResolvedValue(undefined) };
}

function validDto(overrides: Partial<AdminPricingConfigDto> = {}): AdminPricingConfigDto {
  return {
    boostBidCpm: 50,
    boostBidCpc: 5,
    spotlightMultiplier: 3,
    boostMinBudget: 149,
    moderationReviewFee: 50,
    boostDurations: [7, 14, 30],
    boostBudgetPresets: [149, 499, 999],
    walletTopupMinAmount: 149,
    walletTopupPresets: [149, 499, 999],
    ...overrides,
  };
}

describe('ConnectPricingConfigService', () => {
  let model: ReturnType<typeof makeFakeModel>;
  let audit: ReturnType<typeof makeAudit>;
  let svc: ConnectPricingConfigService;

  beforeEach(() => {
    model = makeFakeModel();
    audit = makeAudit();
    svc = new ConnectPricingConfigService(model as any, audit as any);
  });

  it('seeded defaults equal the previous hardcoded values (moved, not changed)', async () => {
    const view = await svc.getConfig(1_000);
    const expected: ConnectPricingView = {
      boostBidCpm: 40,
      boostBidCpc: 4,
      spotlightMultiplier: 2,
      boostMinBudget: 99,
      moderationReviewFee: 25,
      boostDurations: [3, 7, 14, 30],
      boostBudgetPresets: [99, 299, 500, 1000],
      walletTopupMinAmount: 99,
      walletTopupPresets: [99, 299, 500, 1000],
    };
    expect(view).toEqual(expected);
    // And the shared defaults constant matches too (single source for seed +
    // BoostService fallback + this snapshot).
    expect({
      ...CONNECT_PRICING_DEFAULTS,
      boostDurations: [...CONNECT_PRICING_DEFAULTS.boostDurations],
    }).toMatchObject(expected);
  });

  it('admin write is reflected on the next read (cache busted)', async () => {
    await svc.getConfig(1_000); // warm the cache with defaults
    await svc.updateConfig(validDto(), 'admin1');
    // Same timestamp as the warm read: if the cache were NOT busted on write the
    // stale default would come back. It must return the new value instead.
    const after = await svc.getConfig(1_000);
    expect(after.boostBidCpm).toBe(50);
    expect(after.boostMinBudget).toBe(149);
    expect(after.boostDurations).toEqual([7, 14, 30]);
  });

  it('serves from cache within the TTL and refetches after it', async () => {
    const a = await svc.getConfig(1_000);
    // Mutate the store directly; a cached read must NOT see it.
    (model._peek() as any).boostBidCpm = 999;
    const cached = await svc.getConfig(1_030); // within 60s TTL
    expect(cached.boostBidCpm).toBe(a.boostBidCpm);
    const fresh = await svc.getConfig(70_000); // past TTL
    expect(fresh.boostBidCpm).toBe(999);
  });

  it('audits the admin write', async () => {
    await svc.updateConfig(validDto(), 'admin42');
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    const arg = audit.logEvent.mock.calls[0][0];
    expect(arg.action).toBe('pricing_config_updated');
    expect(arg.actorId).toBe('admin42');
  });

  it('normalises durations/presets (sorted + de-duplicated) on write', async () => {
    const view = await svc.updateConfig(
      validDto({ boostDurations: [30, 7, 7, 14], boostBudgetPresets: [999, 149, 149] }),
      'admin1',
    );
    expect(view.boostDurations).toEqual([7, 14, 30]);
    expect(view.boostBudgetPresets).toEqual([149, 999]);
  });

  describe('guardrails reject out-of-bounds writes', () => {
    it('rejects a zero/negative bid', async () => {
      await expect(svc.updateConfig(validDto({ boostBidCpm: 0 }), 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a spotlight multiplier above the ceiling', async () => {
      await expect(
        svc.updateConfig(validDto({ spotlightMultiplier: 99 }), 'a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a moderation review fee above the ceiling (max 500)', async () => {
      await expect(
        svc.updateConfig(validDto({ moderationReviewFee: 501 }), 'a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a negative moderation review fee', async () => {
      await expect(
        svc.updateConfig(validDto({ moderationReviewFee: -1 }), 'a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a zero moderation review fee (free take-down)', async () => {
      const view = await svc.updateConfig(validDto({ moderationReviewFee: 0 }), 'a');
      expect(view.moderationReviewFee).toBe(0);
    });

    it('rejects a duration beyond the day ceiling', async () => {
      await expect(
        svc.updateConfig(validDto({ boostDurations: [7, 400] }), 'a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty durations list', async () => {
      await expect(svc.updateConfig(validDto({ boostDurations: [] }), 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects too many preset entries', async () => {
      await expect(
        svc.updateConfig(
          validDto({ walletTopupPresets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }),
          'a',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not audit or persist a rejected write', async () => {
      await svc.getConfig(1_000);
      await expect(svc.updateConfig(validDto({ boostBidCpm: -1 }), 'a')).rejects.toThrow();
      expect(audit.logEvent).not.toHaveBeenCalled();
      // Store still holds the seeded defaults, untouched.
      expect((model._peek() as any).boostBidCpm).toBe(40);
    });
  });
});
