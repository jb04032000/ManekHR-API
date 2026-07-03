/**
 * Phase 17 / FIN-16-02 D-12 — deriveGstinRisk unit tests.
 *
 * Plan-declared path is __tests__/unit/party-intelligence/gstin-risk.spec.ts;
 * project actual vitest discovery pattern is src+star-star+vitest.ts. Plan
 * path stub re-points here (Phase 15-05 precedent).
 */
import { describe, it, expect } from 'vitest';
import { deriveGstinRisk } from './gstin-risk.util';
import { gstinPeriodsFixture } from '../../../../../test-utils/gstin-fixtures';
import type { GstinFilingPeriod } from './filing-status.types';

describe('deriveGstinRisk (D-12)', () => {
  it("returns OK when last 3 GSTR-3B periods are FILED", () => {
    const p = gstinPeriodsFixture({
      last3Status: ['FILED', 'FILED', 'FILED'],
    });
    expect(deriveGstinRisk(p)).toBe('OK');
  });

  it("returns WATCH when 1 missed but most recent is FILED (non-consecutive)", () => {
    // last3Status order in fixture: index 0 = MOST RECENT.
    // ['FILED','NOT_FILED','FILED'] → most recent FILED, middle missed,
    // older FILED. After ascending sort, last3 looks: [FILED, NOT_FILED, FILED].
    // Consecutive missed from end = 0 → anyMissed → WATCH.
    const p = gstinPeriodsFixture({
      last3Status: ['FILED', 'NOT_FILED', 'FILED'],
    });
    expect(deriveGstinRisk(p)).toBe('WATCH');
  });

  it("returns RISK when 2 consecutive recent periods are missed", () => {
    // ['NOT_FILED','NOT_FILED','FILED'] → recent + middle missed,
    // older FILED. After asc sort last3 = [FILED, NOT_FILED, NOT_FILED].
    // Consecutive missed from end = 2 → RISK.
    const p = gstinPeriodsFixture({
      last3Status: ['NOT_FILED', 'NOT_FILED', 'FILED'],
    });
    expect(deriveGstinRisk(p)).toBe('RISK');
  });

  it('returns CRITICAL when 3+ consecutive recent periods are missed', () => {
    const p = gstinPeriodsFixture({
      last3Status: ['NOT_FILED', 'NOT_FILED', 'NOT_FILED'],
    });
    expect(deriveGstinRisk(p)).toBe('CRITICAL');
  });

  it('returns OK when fewer than 3 GSTR-3B periods exist (insufficient signal)', () => {
    const p: GstinFilingPeriod[] = [
      {
        return: 'GSTR-3B',
        period: '03-2025',
        dueDate: new Date('2025-04-20'),
        filedDate: null,
        status: 'NOT_FILED',
      },
      {
        return: 'GSTR-3B',
        period: '02-2025',
        dueDate: new Date('2025-03-20'),
        filedDate: null,
        status: 'NOT_FILED',
      },
    ];
    expect(deriveGstinRisk(p)).toBe('OK');
  });

  it('filters out GSTR-1 entries (only GSTR-3B drives risk per D-12)', () => {
    // 3 GSTR-1 entries (all NOT_FILED) but only 2 GSTR-3B → returns OK
    // because GSTR-3B count < 3.
    const p: GstinFilingPeriod[] = [
      { return: 'GSTR-1', period: '01-2025', dueDate: new Date('2025-02-11'), filedDate: null, status: 'NOT_FILED' },
      { return: 'GSTR-1', period: '02-2025', dueDate: new Date('2025-03-11'), filedDate: null, status: 'NOT_FILED' },
      { return: 'GSTR-1', period: '03-2025', dueDate: new Date('2025-04-11'), filedDate: null, status: 'NOT_FILED' },
      { return: 'GSTR-3B', period: '01-2025', dueDate: new Date('2025-02-20'), filedDate: new Date('2025-02-15'), status: 'FILED' },
      { return: 'GSTR-3B', period: '02-2025', dueDate: new Date('2025-03-20'), filedDate: new Date('2025-03-15'), status: 'FILED' },
    ];
    expect(deriveGstinRisk(p)).toBe('OK');
  });
});
