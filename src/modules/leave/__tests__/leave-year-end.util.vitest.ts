import { describe, it, expect } from 'vitest';
import { computeYearEndDistribution, YearEndRuleInput } from '../leave-year-end.util';

const rule = (over: Partial<YearEndRuleInput>): YearEndRuleInput => ({
  carryForwardCap: 0,
  lapseExcess: true,
  encashable: false,
  encashmentCap: null,
  ...over,
});

describe('computeYearEndDistribution', () => {
  it('returns all-zero for a non-positive balance', () => {
    expect(computeYearEndDistribution(0, rule({ carryForwardCap: 10, encashable: true }))).toEqual({
      encashed: 0,
      carriedForward: 0,
      lapsed: 0,
    });
  });

  it('carries forward up to the cap and lapses the rest', () => {
    expect(computeYearEndDistribution(10, rule({ carryForwardCap: 6 }))).toEqual({
      encashed: 0,
      carriedForward: 6,
      lapsed: 4,
    });
  });

  it('carries the whole balance when it is under the cap', () => {
    expect(computeYearEndDistribution(4, rule({ carryForwardCap: 63 }))).toEqual({
      encashed: 0,
      carriedForward: 4,
      lapsed: 0,
    });
  });

  it('lapses everything when the carry-forward cap is zero (CL/SL pattern)', () => {
    expect(computeYearEndDistribution(7, rule({}))).toEqual({
      encashed: 0,
      carriedForward: 0,
      lapsed: 7,
    });
  });

  it('encashes first (uncapped), leaving nothing to carry', () => {
    expect(computeYearEndDistribution(20, rule({ carryForwardCap: 63, encashable: true }))).toEqual(
      { encashed: 20, carriedForward: 0, lapsed: 0 },
    );
  });

  it('caps encashment, then carries forward the remainder', () => {
    expect(
      computeYearEndDistribution(
        20,
        rule({ carryForwardCap: 63, encashable: true, encashmentCap: 5 }),
      ),
    ).toEqual({ encashed: 5, carriedForward: 15, lapsed: 0 });
  });

  it('keeps an uncarried remainder in the year when lapseExcess is false', () => {
    expect(
      computeYearEndDistribution(10, rule({ carryForwardCap: 6, lapseExcess: false })),
    ).toEqual({ encashed: 0, carriedForward: 6, lapsed: 0 });
  });
});
