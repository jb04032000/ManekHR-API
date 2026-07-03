import { describe, it, expect } from 'vitest';
import { roundPaise, gstHalves, igstPaise, PAISE_PER_RUPEE } from '../precision';
import {
  effectiveRateCentiPaise,
  lineAmountPaise,
  rateCentiPaiseFromRupees,
  ratePaiseFromCentiPaise,
  CENTIPAISE_PER_PAISE,
} from '../precision';

describe('roundPaise - half away from zero', () => {
  it('rounds positive halves up', () => {
    expect(roundPaise(2.5)).toBe(3);
    expect(roundPaise(0.5)).toBe(1);
  });
  it('rounds negative halves away from zero (correct for credit notes)', () => {
    expect(roundPaise(-2.5)).toBe(-3);
    expect(roundPaise(-0.5)).toBe(-1);
  });
  it('leaves sub-half values toward zero', () => {
    expect(roundPaise(2.4)).toBe(2);
    expect(roundPaise(-2.4)).toBe(-2);
    expect(roundPaise(0)).toBe(0);
  });
  it('PAISE_PER_RUPEE is 100', () => {
    expect(PAISE_PER_RUPEE).toBe(100);
  });
});

describe('gstHalves - equal CGST = SGST', () => {
  it('splits 5% on Rs 200 into equal halves', () => {
    // taxable 20000 paise, 5% -> each half = round(20000 * 2.5 / 100) = 500
    expect(gstHalves(20000, 5)).toEqual({ cgstPaise: 500, sgstPaise: 500 });
  });
  it('rounds each half independently (Rs 101 at 5% -> 253/253, total 506)', () => {
    // 10100 * 2.5 / 100 = 252.5 -> 253 each. Equal halves, total 506.
    expect(gstHalves(10100, 5)).toEqual({ cgstPaise: 253, sgstPaise: 253 });
  });
});

describe('igstPaise', () => {
  it('computes full rate on taxable', () => {
    expect(igstPaise(20000, 5)).toBe(1000);
    expect(igstPaise(10050, 18)).toBe(1809); // 10050*18/100 = 1809
  });
});

describe('rate precision (4 dp via centi-paise)', () => {
  it('CENTIPAISE_PER_PAISE is 100', () => {
    expect(CENTIPAISE_PER_PAISE).toBe(100);
  });
  it('effectiveRateCentiPaise prefers rateCentiPaise when present', () => {
    expect(effectiveRateCentiPaise({ rateCentiPaise: 101113, ratePaise: 1011 })).toBe(101113);
  });
  it('effectiveRateCentiPaise upscales ratePaise when rateCentiPaise absent (back-compat)', () => {
    expect(effectiveRateCentiPaise({ ratePaise: 1011 })).toBe(101100);
    expect(effectiveRateCentiPaise({ rateCentiPaise: null as any, ratePaise: 1011 })).toBe(101100);
  });
  it('lineAmountPaise rounds once (Rs 10.005 x 100 = Rs 1000.50, 4 dp matters)', () => {
    // 100 * 100050 / 100 = 100050 paise = Rs 1000.50
    expect(lineAmountPaise(100, 100050)).toBe(100050);
  });
  it('lineAmountPaise back-compat equals roundPaise(qty * ratePaise) when rate upscaled', () => {
    // qty 2, ratePaise 10000 -> centi 1000000 -> 2*1000000/100 = 20000
    expect(lineAmountPaise(2, effectiveRateCentiPaise({ ratePaise: 10000 }))).toBe(20000);
  });
  it('rateCentiPaiseFromRupees captures 4 dp', () => {
    expect(rateCentiPaiseFromRupees(10.1113)).toBe(101113);
    expect(rateCentiPaiseFromRupees(10.005)).toBe(100050);
  });
  it('ratePaiseFromCentiPaise is the rounded 2-dp display mirror', () => {
    expect(ratePaiseFromCentiPaise(101113)).toBe(1011); // Rs 10.1113 -> Rs 10.11
    expect(ratePaiseFromCentiPaise(100050)).toBe(1001); // Rs 10.005 -> Rs 10.01 (half away from zero)
  });
});
