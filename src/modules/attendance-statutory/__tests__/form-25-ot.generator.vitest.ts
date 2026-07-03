import { describe, it, expect } from 'vitest';
import { generateForm25Ot } from '../generators/form-25-ot.generator';
import type { OtSummaryRow, StatutoryMeta } from '../types/statutory.types';

function meta(): StatutoryMeta {
  return { workspaceId: 'ws1', workspaceName: 'Acme Corp', from: '2026-04-01', to: '2026-04-30', generatedAt: new Date() };
}

describe('generateForm25Ot', () => {
  it('returns a valid PDF buffer when OT days present', () => {
    const rows: OtSummaryRow[] = [{
      memberId: 'm1', name: 'A', employeeCode: 'E1', designation: 'Op',
      days: [{ date: '2026-04-10', otMinutes: 120, dailyRate: 1000, otAmount: 500, rateSource: 'salary_ledger' }],
      totalOtMinutes: 120, totalOtAmount: 500,
    }];
    const buf = generateForm25Ot(rows, meta());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('handles member with no OT days (skips row or shows zero totals)', () => {
    const rows: OtSummaryRow[] = [{
      memberId: 'm1', name: 'A', employeeCode: 'E1', designation: 'Op',
      days: [], totalOtMinutes: 0, totalOtAmount: 0,
    }];
    const buf = generateForm25Ot(rows, meta());
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('handles empty row list', () => {
    const buf = generateForm25Ot([], meta());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
