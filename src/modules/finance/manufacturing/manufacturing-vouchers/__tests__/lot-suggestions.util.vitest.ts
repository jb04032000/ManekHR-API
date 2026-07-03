import { describe, it, expect } from 'vitest';
import { buildLotSuggestion } from '../lot-suggestions.util';

describe('buildLotSuggestion', () => {
  const lot = (over: Partial<Record<string, unknown>> = {}) => ({
    _id: 'lot-default',
    lotNo: 'LOT-DEFAULT',
    inwardDate: new Date('2026-01-10T00:00:00.000Z'),
    qtyRemaining: 5,
    ...over,
  });

  it('wraps the result under the itemId passed in', () => {
    const out = buildLotSuggestion('item-1', []);
    expect(out.itemId).toBe('item-1');
    expect(out.suggestions).toEqual([]);
  });

  it('maps lot fields to the web suggestion shape', () => {
    const out = buildLotSuggestion('item-1', [
      lot({
        _id: 'lot-a',
        lotNo: 'LOT-A',
        qtyRemaining: 12,
        inwardDate: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ]);
    expect(out.suggestions).toEqual([
      { lotId: 'lot-a', batchId: 'LOT-A', qty: 12, inwardDate: '2026-02-01T00:00:00.000Z' },
    ]);
  });

  it('drops lots with no remaining quantity', () => {
    const out = buildLotSuggestion('item-1', [
      lot({ _id: 'empty', qtyRemaining: 0 }),
      lot({ _id: 'neg', qtyRemaining: -3 }),
      lot({ _id: 'ok', qtyRemaining: 1 }),
    ]);
    expect(out.suggestions.map((s) => s.lotId)).toEqual(['ok']);
  });

  it('orders suggestions oldest-inward-first (FIFO)', () => {
    const out = buildLotSuggestion('item-1', [
      lot({ _id: 'newer', inwardDate: new Date('2026-03-01T00:00:00.000Z') }),
      lot({ _id: 'oldest', inwardDate: new Date('2026-01-01T00:00:00.000Z') }),
      lot({ _id: 'middle', inwardDate: new Date('2026-02-01T00:00:00.000Z') }),
    ]);
    expect(out.suggestions.map((s) => s.lotId)).toEqual(['oldest', 'middle', 'newer']);
  });

  it('stringifies ObjectId-like _id values', () => {
    const objectIdLike = { toString: () => '507f1f77bcf86cd799439011' };
    const out = buildLotSuggestion('item-1', [lot({ _id: objectIdLike })]);
    expect(out.suggestions[0].lotId).toBe('507f1f77bcf86cd799439011');
  });
});
