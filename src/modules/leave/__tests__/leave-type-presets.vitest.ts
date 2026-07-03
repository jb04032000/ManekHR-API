import { describe, it, expect } from 'vitest';
import { LEAVE_TYPE_PRESETS } from '../constants/leave-type-presets';

describe('LEAVE_TYPE_PRESETS', () => {
  it('ships exactly 8 leave types', () => {
    expect(LEAVE_TYPE_PRESETS).toHaveLength(8);
  });

  it('has unique, uppercase codes', () => {
    const codes = LEAVE_TYPE_PRESETS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toBe(code.toUpperCase());
    }
  });

  it('includes the expected India statutory set', () => {
    const codes = LEAVE_TYPE_PRESETS.map((p) => p.code).sort();
    expect(codes).toEqual(['BRV', 'CL', 'COMP', 'EL', 'LWP', 'MAT', 'PAT', 'SL']);
  });

  it('marks LWP as the lone system, unpaid overflow type', () => {
    const lwp = LEAVE_TYPE_PRESETS.find((p) => p.code === 'LWP');
    expect(lwp?.isSystem).toBe(true);
    expect(lwp?.isPaid).toBe(false);
    expect(LEAVE_TYPE_PRESETS.filter((p) => p.isSystem)).toHaveLength(1);
  });

  it('seeds CL + SL at the Gujarat Shops-Act floor (7 days, upfront, lapse)', () => {
    for (const code of ['CL', 'SL']) {
      const t = LEAVE_TYPE_PRESETS.find((p) => p.code === code);
      expect(t?.accrualRule.mode).toBe('upfront_annual');
      expect(t?.accrualRule.annualQuantity).toBe(7);
      expect(t?.yearEndRule.lapseExcess).toBe(true);
      expect(t?.statutoryBasis).toBe('shops_act');
    }
  });

  it('accrues EL monthly with the 63-day ceiling, encashable', () => {
    const el = LEAVE_TYPE_PRESETS.find((p) => p.code === 'EL');
    expect(el?.accrualRule.mode).toBe('periodic_accrual');
    expect(el?.accrualRule.rate).toBe(1.5);
    expect(el?.accrualRule.frequency).toBe('monthly');
    expect(el?.accrualRule.accrualCap).toBe(63);
    expect(el?.accrualRule.eligibleAfterDays).toBe(90);
    expect(el?.yearEndRule.carryForwardCap).toBe(63);
    expect(el?.yearEndRule.encashable).toBe(true);
  });

  it('gates maternity to female with a 182-day per-request cap', () => {
    const mat = LEAVE_TYPE_PRESETS.find((p) => p.code === 'MAT');
    expect(mat?.applicability.gender).toBe('female');
    expect(mat?.maxPerRequest).toBe(182);
    expect(mat?.statutoryBasis).toBe('maternity_act');
  });

  it('flags COMP as the lone comp-off type with a 90-day lot validity', () => {
    const comp = LEAVE_TYPE_PRESETS.find((p) => p.code === 'COMP');
    expect(comp?.compOff.isCompOff).toBe(true);
    expect(comp?.compOff.validityDays).toBe(90);
    expect(LEAVE_TYPE_PRESETS.filter((p) => p.compOff.isCompOff)).toHaveLength(1);
  });

  it('gives every preset an en + gu label and a positive sortOrder', () => {
    for (const p of LEAVE_TYPE_PRESETS) {
      expect(p.labels.en.length).toBeGreaterThan(0);
      expect((p.labels.gu ?? '').length).toBeGreaterThan(0);
      expect(p.sortOrder).toBeGreaterThan(0);
    }
  });
});
