import { describe, it, expect } from 'vitest';
import { generateLopAudit } from '../generators/lop-audit.generator';
import type { LopSummaryRow, StatutoryMeta } from '../types/statutory.types';

function meta(): StatutoryMeta {
  return { workspaceId: 'ws1', workspaceName: 'Acme', from: '2026-04-01', to: '2026-04-30', generatedAt: new Date() };
}

describe('generateLopAudit', () => {
  it('returns PDF buffer with per-day rows', () => {
    const rows: LopSummaryRow[] = [{
      memberId: 'm1', name: 'A', employeeCode: 'E1', designation: 'Op',
      days: [
        { date: '2026-04-05', status: 'half_day', shiftDurationMinutes: 480, workedMinutes: 240, lopMinutes: 240, computeReason: 'Checked in 4 hrs late' },
        { date: '2026-04-12', status: 'absent', shiftDurationMinutes: 480, workedMinutes: null, lopMinutes: 480, computeReason: 'No check-in recorded' },
      ],
      totalLopMinutes: 720, totalLopDays: 2, baseSalary: 30000, deductionAmount: 2500,
    }];
    const buf = generateLopAudit(rows, meta());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('handles null baseSalary (no salary generated yet)', () => {
    const rows: LopSummaryRow[] = [{
      memberId: 'm1', name: 'A', employeeCode: null, designation: null,
      days: [], totalLopMinutes: 0, totalLopDays: 0, baseSalary: null, deductionAmount: null,
    }];
    const buf = generateLopAudit(rows, meta());
    expect(Buffer.isBuffer(buf)).toBe(true);
  });
});
