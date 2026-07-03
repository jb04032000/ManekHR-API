import { describe, it, expect } from 'vitest';
import { DepreciationMathService, DepreciationInput } from './depreciation-math.service';

describe('DepreciationMathService', () => {
  const svc = new DepreciationMathService();

  function baseInput(overrides: Partial<DepreciationInput> = {}): DepreciationInput {
    return {
      costPaise: 10000000,             // ₹100,000
      salvageValuePaise: 500000,       // ₹5,000 (5%)
      depreciableAmountPaise: 9500000, // ₹95,000
      usefulLifeYears: 10,
      depreciationMethod: 'slm',
      slmRate: 0.095,
      wdvRate: 0.2589,
      shiftType: 'single',
      isNesd: false,
      openingNbvPaise: 10000000,
      accumulatedDepreciationPaise: 0,
      purchaseDate: new Date('2024-04-01'),
      ...overrides,
    };
  }

  it('SLM full year matches (cost - salvage) / useful life', () => {
    const out = svc.computeForPeriod(baseInput(), new Date('2024-04-01'), new Date('2025-04-01'));
    // 9500000 / 10 = 950000 paise (₹9,500)
    expect(out.amountPaise).toBe(950000);
  });

  it('WDV full year matches openingNbv * rate', () => {
    const out = svc.computeForPeriod(
      baseInput({ depreciationMethod: 'wdv', wdvRate: 0.181 }),
      new Date('2024-04-01'),
      new Date('2025-04-01'),
    );
    // 10000000 * 0.181 = 1810000 paise
    expect(out.amountPaise).toBe(1810000);
  });

  it('SLM partial first month with mid-month purchase prorates correctly', () => {
    const out = svc.computeForPeriod(
      baseInput({ purchaseDate: new Date('2024-04-15') }),
      new Date('2024-04-01'),
      new Date('2024-05-01'),
    );
    // 9500000/10 = 950000/yr; 16 days / 365 = ~41644 paise
    expect(out.amountPaise).toBeGreaterThan(40000);
    expect(out.amountPaise).toBeLessThan(43000);
  });

  it('caps at salvage value — never goes below', () => {
    const out = svc.computeForPeriod(
      baseInput({ openingNbvPaise: 600000, salvageValuePaise: 500000, depreciableAmountPaise: 100000 }),
      new Date('2024-04-01'),
      new Date('2025-04-01'),
    );
    // Annual would be 100000/10=10000 — fits within 100000 remaining; not capped
    expect(out.capped).toBe(false);
    // Now exceed remaining
    const out2 = svc.computeForPeriod(
      baseInput({
        openingNbvPaise: 510000,
        salvageValuePaise: 500000,
        depreciableAmountPaise: 9500000,
        slmRate: 0.5,
      }),
      new Date('2024-04-01'),
      new Date('2025-04-01'),
    );
    expect(out2.capped).toBe(true);
    expect(out2.amountPaise).toBe(10000);
  });

  it('double shift adds 50% to base depreciation', () => {
    const single = svc.computeForPeriod(baseInput(), new Date('2024-04-01'), new Date('2025-04-01'));
    const double = svc.computeForPeriod(
      baseInput({ shiftType: 'double' }),
      new Date('2024-04-01'),
      new Date('2025-04-01'),
    );
    expect(double.amountPaise).toBe(Math.round(single.amountPaise * 1.5));
  });

  it('NESD ignores shift multiplier', () => {
    const out = svc.computeForPeriod(
      baseInput({ shiftType: 'triple', isNesd: true }),
      new Date('2024-04-01'),
      new Date('2025-04-01'),
    );
    expect(out.shiftMultiplier).toBe(1.0);
    expect(out.amountPaise).toBe(950000);
  });

  it('IT Act 180-day rule returns 0.5 multiplier for late-year acquisition', () => {
    expect(svc.itAct180DayMultiplier(new Date('2024-12-01'), new Date('2025-03-31'))).toBe(0.5);
    expect(svc.itAct180DayMultiplier(new Date('2024-04-01'), new Date('2025-03-31'))).toBe(1.0);
  });
});
