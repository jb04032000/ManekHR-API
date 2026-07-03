/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// ---- Will fail until rollup.cron.ts exists (RED phase for pure helper) ----
import { RollupCron, computeRates, yesterdayIst } from '../rollup.cron';

// ---------------------------------------------------------------------------
// Pure helper tests (full TDD coverage)
// ---------------------------------------------------------------------------

describe('computeRates', () => {
  it('computes ctr = clicks / impressions', () => {
    const result = computeRates({
      impressions: 1000,
      viewableImpressions: 900,
      clicks: 50,
      validClicks: 48,
      spend: 10,
    });
    expect(result.ctr).toBeCloseTo(0.05);
  });

  it('computes viewabilityRate = viewableImpressions / impressions', () => {
    const result = computeRates({
      impressions: 1000,
      viewableImpressions: 900,
      clicks: 50,
      validClicks: 48,
      spend: 10,
    });
    expect(result.viewabilityRate).toBeCloseTo(0.9);
  });

  it('returns ctr=0 and viewabilityRate=0 when impressions=0 (zero-safe, no NaN/Infinity)', () => {
    const result = computeRates({
      impressions: 0,
      viewableImpressions: 0,
      clicks: 0,
      validClicks: 0,
      spend: 0,
    });
    expect(result.ctr).toBe(0);
    expect(result.viewabilityRate).toBe(0);
  });

  it('ctr and viewabilityRate are not affected by validClicks or spend values', () => {
    const a = computeRates({
      impressions: 1000,
      viewableImpressions: 800,
      clicks: 100,
      validClicks: 0,
      spend: 0,
    });
    const b = computeRates({
      impressions: 1000,
      viewableImpressions: 800,
      clicks: 100,
      validClicks: 999,
      spend: 9999,
    });
    expect(a.ctr).toBeCloseTo(b.ctr);
    expect(a.viewabilityRate).toBeCloseTo(b.viewabilityRate);
  });

  it('ctr=1 when clicks equals impressions', () => {
    const result = computeRates({
      impressions: 100,
      viewableImpressions: 50,
      clicks: 100,
      validClicks: 100,
      spend: 5,
    });
    expect(result.ctr).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// yesterdayIst helper tests
// ---------------------------------------------------------------------------

describe('yesterdayIst', () => {
  it('returns a date string matching YYYY-MM-DD format', () => {
    const { dateStr } = yesterdayIst(Date.now());
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('utcEnd is exactly 24 hours after utcStart', () => {
    const { utcStart, utcEnd } = yesterdayIst(Date.now());
    expect(utcEnd.getTime() - utcStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('returns the correct IST date for a known UTC timestamp', () => {
    // 2026-05-26 00:00:00 UTC = 2026-05-26 05:30:00 IST
    // "Yesterday" in IST from that point = 2026-05-25
    const utcMs = Date.UTC(2026, 4, 26, 0, 0, 0); // month is 0-indexed
    const { dateStr } = yesterdayIst(utcMs);
    expect(dateStr).toBe('2026-05-25');
  });

  it('returns the correct IST date at 23:59 UTC (still yesterday IST)', () => {
    // 2026-05-26 23:59:00 UTC = 2026-05-27 05:29:00 IST -> yesterday IST = 2026-05-26
    const utcMs = Date.UTC(2026, 4, 26, 23, 59, 0);
    const { dateStr } = yesterdayIst(utcMs);
    expect(dateStr).toBe('2026-05-26');
  });
});

// ---------------------------------------------------------------------------
// RollupCron.tick tests (mock models)
// ---------------------------------------------------------------------------

function makeMockImpressionModel(buckets: any[]) {
  return {
    aggregate: vi.fn(() => Promise.resolve(buckets)),
  };
}

function makeMockClickModel(buckets: any[]) {
  return {
    aggregate: vi.fn(() => Promise.resolve(buckets)),
  };
}

function makeMockRollupModel() {
  return {
    updateOne: vi.fn((): Promise<any> => Promise.resolve({ upsertedCount: 1 })),
  };
}

describe('RollupCron.tick', () => {
  describe('single campaign with matching impressions and clicks', () => {
    it('upserts rollup with correct rates, counts, and a YYYY-MM-DD date', async () => {
      const mockImpression = makeMockImpressionModel([
        { _id: 'c1', impressions: 1000, viewableImpressions: 900, spend: 40 },
      ]);
      // CN-ADS-2 (feed harden): the click aggregation now also sums chargeAmount.
      // A CPM campaign's clicks carry no charge, so spend is 0 on the click side;
      // total spend = impression spend (40) + click spend (0).
      const mockClick = makeMockClickModel([{ _id: 'c1', clicks: 50, validClicks: 48, spend: 0 }]);
      const mockRollup = makeMockRollupModel();

      const cron = new RollupCron(mockImpression as any, mockClick as any, mockRollup as any);

      await cron.tick(Date.now());

      expect(mockRollup.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update, options] = mockRollup.updateOne.mock.calls[0] as [any, any, any];

      // Filter is keyed by campaignId + date.
      expect(String(filter.campaignId)).toBe('c1');
      expect(filter.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // $set payload.
      const { $set } = update;
      expect($set.impressions).toBe(1000);
      expect($set.viewableImpressions).toBe(900);
      expect($set.spend).toBe(40);
      expect($set.clicks).toBe(50);
      expect($set.validClicks).toBe(48);
      expect($set.ctr).toBeCloseTo(0.05);
      expect($set.viewabilityRate).toBeCloseTo(0.9);

      // Upsert flag is set.
      expect(options).toEqual(expect.objectContaining({ upsert: true }));
    });
  });

  describe('campaign with impressions but no clicks', () => {
    it('defaults clicks and validClicks to 0, ctr to 0', async () => {
      const mockImpression = makeMockImpressionModel([
        { _id: 'c2', impressions: 500, viewableImpressions: 400, spend: 20 },
      ]);
      const mockClick = makeMockClickModel([]); // no clicks
      const mockRollup = makeMockRollupModel();

      const cron = new RollupCron(mockImpression as any, mockClick as any, mockRollup as any);

      await cron.tick(Date.now());

      const [, update] = mockRollup.updateOne.mock.calls[0] as [any, any];
      const { $set } = update;
      expect($set.clicks).toBe(0);
      expect($set.validClicks).toBe(0);
      expect($set.ctr).toBe(0);
      expect($set.viewabilityRate).toBeCloseTo(0.8);
    });
  });

  describe('no impressions for the day', () => {
    it('does not call rollupModel.updateOne when impression aggregate returns empty', async () => {
      const mockImpression = makeMockImpressionModel([]);
      const mockClick = makeMockClickModel([]);
      const mockRollup = makeMockRollupModel();

      const cron = new RollupCron(mockImpression as any, mockClick as any, mockRollup as any);

      await cron.tick(Date.now());

      expect(mockRollup.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('multiple campaigns', () => {
    it('upserts one rollup document per campaign', async () => {
      const mockImpression = makeMockImpressionModel([
        { _id: 'cA', impressions: 200, viewableImpressions: 180, spend: 8 },
        { _id: 'cB', impressions: 300, viewableImpressions: 270, spend: 12 },
      ]);
      const mockClick = makeMockClickModel([
        { _id: 'cA', clicks: 20, validClicks: 19, spend: 0 },
        { _id: 'cB', clicks: 30, validClicks: 28, spend: 0 },
      ]);
      const mockRollup = makeMockRollupModel();

      const cron = new RollupCron(mockImpression as any, mockClick as any, mockRollup as any);

      await cron.tick(Date.now());

      expect(mockRollup.updateOne).toHaveBeenCalledTimes(2);
    });
  });

  // CN-ADS-2 (feed harden Bucket 3): a CPC campaign bills on click, so its spend
  // lives entirely in the click aggregation. Previously the click side never
  // summed chargeAmount AND the loop only iterated impression buckets, so a CPC
  // campaign with clicks but no impression bucket rolled up spend:0 (or was
  // skipped). Now the union of campaign ids is iterated and click spend is added.
  describe('CN-ADS-2: CPC click spend', () => {
    it('rolls up a click-only campaign (no impression bucket) with its click spend', async () => {
      const mockImpression = makeMockImpressionModel([]); // CPC: no impression bucket
      const mockClick = makeMockClickModel([
        { _id: 'cpc1', clicks: 10, validClicks: 9, spend: 36 },
      ]);
      const mockRollup = makeMockRollupModel();

      const cron = new RollupCron(mockImpression as any, mockClick as any, mockRollup as any);
      await cron.tick(Date.now());

      // The campaign still gets a rollup row (union iteration), with the click spend.
      expect(mockRollup.updateOne).toHaveBeenCalledTimes(1);
      const [, update] = mockRollup.updateOne.mock.calls[0] as [any, any];
      expect(update.$set.spend).toBe(36);
      expect(update.$set.clicks).toBe(10);
      expect(update.$set.impressions).toBe(0);
    });
  });
});
