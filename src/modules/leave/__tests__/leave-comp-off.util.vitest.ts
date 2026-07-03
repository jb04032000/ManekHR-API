import { describe, it, expect } from 'vitest';
import { allocateFifo, CompOffLot, isEarnableCompOffDay } from '../leave-comp-off.util';

describe('allocateFifo', () => {
  const lots: CompOffLot[] = [
    { ledgerEntryId: 'a', year: 2026, lotRemaining: 2 },
    { ledgerEntryId: 'b', year: 2026, lotRemaining: 3 },
  ];

  it('draws from the first lot when it covers the request', () => {
    const r = allocateFifo(lots, 1.5);
    expect(r.shortfall).toBe(0);
    expect(r.allocations).toEqual([{ ledgerEntryId: 'a', year: 2026, consumed: 1.5 }]);
  });

  it('spills oldest-first across lots', () => {
    const r = allocateFifo(lots, 4);
    expect(r.shortfall).toBe(0);
    expect(r.allocations).toEqual([
      { ledgerEntryId: 'a', year: 2026, consumed: 2 },
      { ledgerEntryId: 'b', year: 2026, consumed: 2 },
    ]);
  });

  it('consumes every lot exactly', () => {
    const r = allocateFifo(lots, 5);
    expect(r.shortfall).toBe(0);
    expect(r.allocations.map((a) => a.consumed)).toEqual([2, 3]);
  });

  it('reports a shortfall when the lots cannot cover the request', () => {
    const r = allocateFifo(lots, 7);
    expect(r.shortfall).toBe(2);
    expect(r.allocations.map((a) => a.consumed)).toEqual([2, 3]);
  });

  it('returns an empty allocation + full shortfall for no lots', () => {
    const r = allocateFifo([], 3);
    expect(r.allocations).toEqual([]);
    expect(r.shortfall).toBe(3);
  });

  it('skips zero-remaining lots', () => {
    const r = allocateFifo(
      [
        { ledgerEntryId: 'x', year: 2026, lotRemaining: 0 },
        { ledgerEntryId: 'y', year: 2026, lotRemaining: 2 },
      ],
      2,
    );
    expect(r.allocations).toEqual([{ ledgerEntryId: 'y', year: 2026, consumed: 2 }]);
    expect(r.shortfall).toBe(0);
  });
});

describe('isEarnableCompOffDay', () => {
  // 2026-01-03 is a Saturday, 2026-01-05 a Monday.
  const sat = new Date(Date.UTC(2026, 0, 3));
  const mon = new Date(Date.UTC(2026, 0, 5));

  it('is earnable when the day is a workspace holiday', () => {
    expect(isEarnableCompOffDay(mon, new Set(['2026-01-05']), new Set())).toBe(true);
  });

  it('is earnable when the day is one of the member weekly-off days', () => {
    expect(isEarnableCompOffDay(sat, new Set(), new Set([6]))).toBe(true);
  });

  it('is not earnable for a normal working day', () => {
    expect(isEarnableCompOffDay(mon, new Set(['2026-01-01']), new Set([0, 6]))).toBe(false);
  });
});
