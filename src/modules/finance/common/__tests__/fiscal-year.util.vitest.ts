import { describe, it, expect } from 'vitest';
import { financialYearOf, getFiscalYearOfDate } from '../fiscal-year.util';

describe('financialYearOf - canonical FY label from a date', () => {
  it('labels a date on the FY start boundary (1 April) into the opening year', () => {
    expect(financialYearOf(new Date('2025-04-01T00:00:00Z'))).toBe('2025-26');
  });

  it('labels a date on the FY end boundary (31 March) into the prior opening year', () => {
    expect(financialYearOf(new Date('2026-03-31T00:00:00Z'))).toBe('2025-26');
  });

  it('labels a mid-year date (June) into the current FY', () => {
    expect(financialYearOf(new Date('2025-06-15T00:00:00Z'))).toBe('2025-26');
  });

  it('labels a January date into the FY that opened the prior April', () => {
    expect(financialYearOf(new Date('2026-01-10T00:00:00Z'))).toBe('2025-26');
  });

  it('defaults the FY start month to April when omitted', () => {
    expect(financialYearOf(new Date('2025-12-31T00:00:00Z'))).toBe('2025-26');
  });

  it('emits a two-digit closing year (never a four-digit "2025-2026")', () => {
    const label = financialYearOf(new Date('2025-06-15T00:00:00Z'));
    expect(label).toMatch(/^\d{4}-\d{2}$/);
  });

  it('honours a configurable FY start month (calendar-year firm, January start)', () => {
    expect(financialYearOf(new Date('2025-01-15T00:00:00Z'), 1)).toBe('2025-26');
    expect(financialYearOf(new Date('2025-12-31T00:00:00Z'), 1)).toBe('2025-26');
  });

  it('honours a July FY start (date before July rolls into the prior FY)', () => {
    expect(financialYearOf(new Date('2025-07-01T00:00:00Z'), 7)).toBe('2025-26');
    expect(financialYearOf(new Date('2025-06-30T00:00:00Z'), 7)).toBe('2024-25');
  });

  it('agrees with the FY-lock window helper (getFiscalYearOfDate) by construction', () => {
    // The FY string and the FY-lock must derive from one source of truth so a
    // voucher can never be numbered into a different FY than the one the lock
    // guards. Verify both agree across the April boundary.
    for (const iso of [
      '2025-04-01T00:00:00Z',
      '2025-06-15T00:00:00Z',
      '2026-03-31T00:00:00Z',
      '2026-01-10T00:00:00Z',
    ]) {
      const d = new Date(iso);
      const { startYear } = getFiscalYearOfDate(d, 4);
      expect(financialYearOf(d, 4)).toBe(`${startYear}-${(startYear + 1).toString().slice(2)}`);
    }
  });
});
