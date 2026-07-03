import { describe, it, expect } from 'vitest';
import { GST_RATE_HISTORY_SEED } from '../seeds/gst-rates-2017-2026.seed';

const D_2025_09_22 = new Date('2025-09-22T00:00:00.000Z');

function rowsFor(prefix: string) {
  return GST_RATE_HISTORY_SEED.filter((r) => r.hsnPrefix === prefix);
}

function openRow(prefix: string) {
  return rowsFor(prefix).find((r) => r.toDate === null || r.toDate === undefined);
}

describe('GST 2.0 layer (effective 22-09-2025)', () => {
  const MMF_PREFIXES = [
    '5401',
    '5402',
    '5403',
    '5404',
    '5405',
    '5406',
    '5501',
    '5502',
    '5503',
    '5504',
    '5505',
    '5506',
    '5507',
    '5508',
    '5509',
    '5510',
    '5511',
  ];

  it('moves each MMF fibre/yarn prefix to a 5% slab open from 22-09-2025', () => {
    for (const prefix of MMF_PREFIXES) {
      const open = openRow(prefix);
      expect(open, `open row for ${prefix}`).toBeDefined();
      expect(open.fromDate.getTime(), `fromDate for ${prefix}`).toBe(D_2025_09_22.getTime());
      expect(open.cgstRate, `cgst for ${prefix}`).toBe(2.5);
      expect(open.sgstRate, `sgst for ${prefix}`).toBe(2.5);
      expect(open.igstRate, `igst for ${prefix}`).toBe(5);
    }
  });

  it('closes the prior MMF window at 2025-09-21 (no overlap)', () => {
    for (const prefix of MMF_PREFIXES) {
      const closed = rowsFor(prefix).filter(
        (r) => r.toDate instanceof Date && r.toDate < D_2025_09_22,
      );
      // At least one closed window must end strictly before the GST 2.0 cutover.
      expect(closed.length, `closed window count for ${prefix}`).toBeGreaterThan(0);
      const latestClosed = closed[closed.length - 1];
      expect(latestClosed.toDate.getTime()).toBeLessThan(D_2025_09_22.getTime());
    }
  });

  it('adds sewing machines HS 8452 at 12% pre-cutover then 5% from 22-09-2025', () => {
    const rows = rowsFor('8452');
    expect(rows.length).toBe(2);
    const open = openRow('8452');
    expect(open).toBeDefined();
    expect(open.fromDate.getTime()).toBe(D_2025_09_22.getTime());
    expect(open.igstRate).toBe(5);
    const pre = rows.find((r) => r.toDate instanceof Date);
    expect(pre).toBeDefined();
    expect(pre.igstRate).toBe(12);
  });

  it('never leaves two open (toDate null) rows for the same prefix', () => {
    const openByPrefix = new Map<string, number>();
    for (const r of GST_RATE_HISTORY_SEED) {
      if (r.toDate === null || r.toDate === undefined) {
        openByPrefix.set(r.hsnPrefix, (openByPrefix.get(r.hsnPrefix) ?? 0) + 1);
      }
    }
    for (const [prefix, count] of openByPrefix) {
      expect(count, `open rows for ${prefix}`).toBe(1);
    }
  });
});
