import { describe, it, expect } from 'vitest';
import { applyEntryToTotals, computeAvailable, emptyTotals } from '../leave-ledger.util';

describe('leave-ledger.util', () => {
  describe('applyEntryToTotals', () => {
    it('opening credit raises opening', () => {
      expect(applyEntryToTotals(emptyTotals(), 'opening', 5).opening).toBe(5);
    });

    it('accrual / carry_forward / comp_off_credit / adjustment raise credited', () => {
      let t = emptyTotals();
      t = applyEntryToTotals(t, 'accrual', 1.5);
      t = applyEntryToTotals(t, 'carry_forward', 2);
      t = applyEntryToTotals(t, 'comp_off_credit', 1);
      t = applyEntryToTotals(t, 'adjustment', 0.5);
      expect(t.credited).toBe(5);
    });

    it('a negative adjustment lowers credited', () => {
      expect(applyEntryToTotals(emptyTotals(), 'adjustment', -2).credited).toBe(-2);
    });

    it('usage (negative qty) raises used; usage_reversal lowers it', () => {
      let t = applyEntryToTotals(emptyTotals(), 'usage', -3);
      expect(t.used).toBe(3);
      t = applyEntryToTotals(t, 'usage_reversal', 1);
      expect(t.used).toBe(2);
    });

    it('lapse + comp_off_expiry raise lapsed', () => {
      let t = applyEntryToTotals(emptyTotals(), 'lapse', -4);
      t = applyEntryToTotals(t, 'comp_off_expiry', -1);
      expect(t.lapsed).toBe(5);
    });

    it('encashment raises encashed', () => {
      expect(applyEntryToTotals(emptyTotals(), 'encashment', -6).encashed).toBe(6);
    });

    it('does not mutate the input totals', () => {
      const base = emptyTotals();
      applyEntryToTotals(base, 'accrual', 9);
      expect(base.credited).toBe(0);
    });
  });

  describe('computeAvailable', () => {
    it('available = opening + credited − used − pending − lapsed − encashed', () => {
      expect(
        computeAvailable({
          opening: 2,
          credited: 10,
          used: 3,
          pending: 1,
          lapsed: 1,
          encashed: 2,
        }),
      ).toBe(5);
    });

    it('a fresh bucket has zero available', () => {
      expect(computeAvailable(emptyTotals())).toBe(0);
    });
  });
});
