import { describe, it, expect } from 'vitest';
import {
  sumRollupRows,
  deriveMetrics,
  last30dIstDateRange,
  currentIstMonthRange,
  type RollupCountRow,
} from '../boost-analytics.helpers';

/**
 * Pure unit tests for the boost-analytics helpers. These power the
 * `GET /connect/ads/boosts` list metrics + `GET /connect/ads/boosts/stats`
 * KPI window. No DB -- we assert the summed counts, the guarded derivations,
 * and the IST date-string window boundaries the service will feed to Mongo.
 *
 * Honesty note: the rollups only carry impressions / clicks / spend, so the
 * helpers derive ONLY ctr + costPerClick. There is deliberately no inquiry /
 * conversion math here because those are not attributed per campaign.
 */

describe('sumRollupRows', () => {
  it('returns all-zero sums for an empty list', () => {
    expect(sumRollupRows([])).toEqual({ impressions: 0, clicks: 0, spend: 0 });
  });

  it('sums impressions, clicks and spend across rows', () => {
    const rows: RollupCountRow[] = [
      { impressions: 1200, clicks: 45, spend: 48 },
      { impressions: 800, clicks: 20, spend: 32 },
    ];
    expect(sumRollupRows(rows)).toEqual({ impressions: 2000, clicks: 65, spend: 80 });
  });

  it('treats missing numeric fields as 0 (defensive against sparse docs)', () => {
    const rows = [{ impressions: 100 }, { clicks: 5 }, { spend: 7 }] as unknown as RollupCountRow[];
    expect(sumRollupRows(rows)).toEqual({ impressions: 100, clicks: 5, spend: 7 });
  });
});

describe('deriveMetrics', () => {
  it('passes impressions/clicks/spend through unchanged', () => {
    const m = deriveMetrics({ impressions: 1000, clicks: 50, spend: 200 });
    expect(m.impressions).toBe(1000);
    expect(m.clicks).toBe(50);
    expect(m.spend).toBe(200);
  });

  it('computes ctr as clicks / impressions', () => {
    expect(deriveMetrics({ impressions: 1000, clicks: 50, spend: 0 }).ctr).toBe(0.05);
  });

  it('guards ctr against divide-by-zero (0 impressions -> ctr 0)', () => {
    const m = deriveMetrics({ impressions: 0, clicks: 5, spend: 10 });
    expect(m.ctr).toBe(0);
    expect(Number.isFinite(m.ctr)).toBe(true);
  });

  it('computes costPerClick as spend / clicks', () => {
    expect(deriveMetrics({ impressions: 100, clicks: 25, spend: 100 }).costPerClick).toBe(4);
  });

  it('guards costPerClick against divide-by-zero (0 clicks -> costPerClick 0)', () => {
    const m = deriveMetrics({ impressions: 100, clicks: 0, spend: 40 });
    expect(m.costPerClick).toBe(0);
    expect(Number.isFinite(m.costPerClick)).toBe(true);
  });

  it('returns exactly the five real metric fields (no inquiries/conversions)', () => {
    const m = deriveMetrics({ impressions: 10, clicks: 1, spend: 2 });
    expect(Object.keys(m).sort()).toEqual(
      ['clicks', 'costPerClick', 'ctr', 'impressions', 'spend'].sort(),
    );
  });
});

describe('last30dIstDateRange', () => {
  // 2026-06-02T12:00:00Z is 2026-06-02 17:30 IST -> IST "today" is 2026-06-02.
  const NOW = Date.parse('2026-06-02T12:00:00.000Z');

  it('ends on today (IST) and starts 29 days earlier (30-day inclusive window)', () => {
    expect(last30dIstDateRange(NOW)).toEqual({
      startDateStr: '2026-05-04',
      endDateStr: '2026-06-02',
    });
  });

  it('uses the IST calendar day, not the UTC day, near the date boundary', () => {
    // 2026-06-02T19:00:00Z = 2026-06-03 00:30 IST -> IST today rolls to the 3rd.
    const lateUtc = Date.parse('2026-06-02T19:00:00.000Z');
    expect(last30dIstDateRange(lateUtc)).toEqual({
      startDateStr: '2026-05-05',
      endDateStr: '2026-06-03',
    });
  });

  it('crosses month boundaries correctly', () => {
    const now = Date.parse('2026-03-05T06:00:00.000Z'); // 2026-03-05 11:30 IST
    expect(last30dIstDateRange(now)).toEqual({
      startDateStr: '2026-02-04',
      endDateStr: '2026-03-05',
    });
  });
});

describe('currentIstMonthRange', () => {
  it('spans the first to the last IST day of the current month', () => {
    const now = Date.parse('2026-06-02T12:00:00.000Z'); // June, IST
    expect(currentIstMonthRange(now)).toEqual({
      startDateStr: '2026-06-01',
      endDateStr: '2026-06-30',
    });
  });

  it('handles 31-day months', () => {
    const now = Date.parse('2026-01-15T12:00:00.000Z');
    expect(currentIstMonthRange(now)).toEqual({
      startDateStr: '2026-01-01',
      endDateStr: '2026-01-31',
    });
  });

  it('handles February in a non-leap year', () => {
    const now = Date.parse('2026-02-10T12:00:00.000Z');
    expect(currentIstMonthRange(now)).toEqual({
      startDateStr: '2026-02-01',
      endDateStr: '2026-02-28',
    });
  });

  it('uses the IST month near the UTC month boundary', () => {
    // 2026-05-31T20:00:00Z = 2026-06-01 01:30 IST -> IST month is June.
    const now = Date.parse('2026-05-31T20:00:00.000Z');
    expect(currentIstMonthRange(now)).toEqual({
      startDateStr: '2026-06-01',
      endDateStr: '2026-06-30',
    });
  });
});
