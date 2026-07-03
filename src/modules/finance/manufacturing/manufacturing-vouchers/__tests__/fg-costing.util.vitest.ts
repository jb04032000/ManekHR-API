import { describe, it, expect } from 'vitest';
import {
  fgNetInputCostPaise,
  fgInwardUnitCostPaise,
  perUnitStandardCostPaise,
  fgMovementUnitCostPaise,
} from '../fg-costing.util';

describe('fgNetInputCostPaise', () => {
  it('returns the full input cost when there are no by-products', () => {
    expect(fgNetInputCostPaise(100000, 0)).toBe(100000);
  });

  it('subtracts the total by-product NRV from the input cost', () => {
    expect(fgNetInputCostPaise(100000, 15000)).toBe(85000);
  });

  it('clamps at 0 when by-product NRV exceeds input cost (matches ledger skipping a non-positive FG debit)', () => {
    expect(fgNetInputCostPaise(10000, 15000)).toBe(0);
  });
});

describe('fgInwardUnitCostPaise', () => {
  it('with no by-products equals total input cost per unit (behaviour preserved)', () => {
    // 100000 paise over 10 units = 10000/unit
    expect(fgInwardUnitCostPaise(100000, 0, 10)).toBe(10000);
  });

  it('nets by-product NRV before dividing so the FG layer matches the ledger FG debit', () => {
    // (100000 - 15000) / 10 = 8500/unit
    expect(fgInwardUnitCostPaise(100000, 15000, 10)).toBe(8500);
  });

  it('rounds to the nearest paise', () => {
    // (100000 - 1) / 3 = 33333/unit (33332.99 rounded)
    expect(fgInwardUnitCostPaise(100000, 1, 3)).toBe(33333);
  });

  it('returns 0 when actualFinishedQty is 0 (no division by zero)', () => {
    expect(fgInwardUnitCostPaise(100000, 0, 0)).toBe(0);
  });

  it('returns 0 when by-product NRV exceeds input cost', () => {
    expect(fgInwardUnitCostPaise(10000, 15000, 5)).toBe(0);
  });
});

describe('perUnitStandardCostPaise', () => {
  it('divides the BoM batch standard cost by the BoM output quantity', () => {
    // 120000 paise to produce 10 units = 12000/unit
    expect(perUnitStandardCostPaise(120000, 10)).toBe(12000);
  });

  it('rounds to the nearest paise', () => {
    // 100000 / 3 = 33333 (33333.33 rounded)
    expect(perUnitStandardCostPaise(100000, 3)).toBe(33333);
  });

  it('returns 0 when outputQty is 0 (no divide-by-zero)', () => {
    expect(perUnitStandardCostPaise(120000, 0)).toBe(0);
  });
});

describe('fgMovementUnitCostPaise', () => {
  it('uses the per-unit standard cost in standard mode', () => {
    expect(
      fgMovementUnitCostPaise({
        costMethod: 'standard',
        totalInputCostPaise: 100000,
        byProductNrvPaise: 15000,
        actualFinishedQty: 10,
        standardFgCostPaise: 9000,
      }),
    ).toBe(9000);
  });

  it('falls back to actual net cost in standard mode when no standard cost is set', () => {
    // (100000 - 15000) / 10 = 8500
    expect(
      fgMovementUnitCostPaise({
        costMethod: 'standard',
        totalInputCostPaise: 100000,
        byProductNrvPaise: 15000,
        actualFinishedQty: 10,
        standardFgCostPaise: 0,
      }),
    ).toBe(8500);
  });

  it('uses actual net cost in actual mode (ignores any standard cost)', () => {
    expect(
      fgMovementUnitCostPaise({
        costMethod: 'actual',
        totalInputCostPaise: 100000,
        byProductNrvPaise: 15000,
        actualFinishedQty: 10,
        standardFgCostPaise: 9000,
      }),
    ).toBe(8500);
  });
});
