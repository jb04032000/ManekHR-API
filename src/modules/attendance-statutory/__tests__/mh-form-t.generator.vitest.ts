import { describe, it, expect } from 'vitest';
import { generateMhFormT } from '../generators/mh-form-t.generator';
import type { AttendanceSummaryRow, StatutoryMeta } from '../types/statutory.types';

function sampleMeta(): StatutoryMeta {
  return {
    workspaceId: 'ws1',
    workspaceName: 'Acme Corp Pvt Ltd',
    from: '2026-04-01',
    to: '2026-04-30',
    generatedAt: new Date('2026-04-30T10:00:00Z'),
  };
}

function sampleRow(): AttendanceSummaryRow {
  return {
    memberId: 'm1',
    name: 'Rahul Sharma',
    employeeCode: 'EMP-001',
    designation: 'Operator',
    days: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      status: i % 7 === 0 ? 'week_off' : 'present',
      checkIn: null,
      checkOut: null,
      workedMinutes: 480,
      lateMinutes: 0,
      otMinutes: 0,
      computeReason: null,
    })),
    totalPresentDays: 26,
    totalAbsentDays: 0,
    totalLateDays: 0,
    totalHalfDays: 0,
    totalOtMinutes: 0,
    totalWorkedMinutes: 26 * 480,
  };
}

describe('generateMhFormT', () => {
  it('returns a non-empty PDF Buffer starting with %PDF magic bytes', () => {
    const buf = generateMhFormT([sampleRow()], sampleMeta());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('handles 50 members (acceptance criterion) — paginates without throwing', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...sampleRow(), memberId: `m${i}`, name: `Member ${i}` }));
    const buf = generateMhFormT(rows, sampleMeta());
    expect(buf.length).toBeGreaterThan(2000);
  });

  it('handles empty member list without throwing', () => {
    const buf = generateMhFormT([], sampleMeta());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
