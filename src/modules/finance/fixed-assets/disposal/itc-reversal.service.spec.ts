import { describe, it, expect } from 'vitest';
import { ItcReversalService } from './itc-reversal.service';

describe('ItcReversalService', () => {
  const svc = new ItcReversalService();

  it('returns not-applicable with reasonCode=no_itc when itcClaimedPaise is 0', () => {
    const r = svc.computeReversal(0, new Date('2024-04-01'), new Date('2024-10-01'));
    expect(r.applicable).toBe(false);
    expect(r.reasonCode).toBe('no_itc');
    expect(r.reversalPaise).toBe(0);
    expect(r.rule).toBe('none');
  });

  it('returns not-applicable with reasonCode=beyond_60_months when held >= 60 months', () => {
    // Exactly 60 months: 2018-01-01 to 2023-01-01
    const r = svc.computeReversal(60000, new Date('2018-01-01'), new Date('2023-01-01'));
    expect(r.applicable).toBe(false);
    expect(r.reasonCode).toBe('beyond_60_months');
    expect(r.monthsUsed).toBeGreaterThanOrEqual(60);
    expect(r.reversalPaise).toBe(0);
  });

  it('applies Rule 44(6): held 30 months → reverse ITC × 30/60', () => {
    // 2022-01-01 to 2024-07-01 = exactly 30 full months
    const r = svc.computeReversal(60000, new Date('2022-01-01'), new Date('2024-07-01'));
    expect(r.applicable).toBe(true);
    expect(r.monthsUsed).toBe(30);
    expect(r.monthsRemaining).toBe(30);
    expect(r.reversalPaise).toBe(30000); // 60000 × 30/60
    expect(r.rule).toBe('rule_44_6');
  });

  it('partial month does not count as full month (disposal day < purchase day)', () => {
    // 2024-01-15 to 2024-07-10: month diff = 6, but day 10 < 15 → truncates to 5
    const r = svc.computeReversal(60000, new Date('2024-01-15'), new Date('2024-07-10'));
    expect(r.monthsUsed).toBe(5);
    expect(r.monthsRemaining).toBe(55);
  });

  it('disposal same day as purchase returns 0 months used', () => {
    const d = new Date('2024-03-01');
    const r = svc.computeReversal(10000, d, d);
    expect(r.applicable).toBe(true);
    expect(r.monthsUsed).toBe(0);
    expect(r.monthsRemaining).toBe(60);
    expect(r.reversalPaise).toBe(10000); // 100% reversal
  });

  it('held exactly 59 months → 1 month remaining → minimal reversal', () => {
    // 2018-01-01 to 2022-12-01 = 59 months
    const r = svc.computeReversal(60000, new Date('2018-01-01'), new Date('2022-12-01'));
    expect(r.applicable).toBe(true);
    expect(r.monthsUsed).toBe(59);
    expect(r.monthsRemaining).toBe(1);
    expect(r.reversalPaise).toBe(1000); // 60000 × 1/60 = 1000
  });
});
