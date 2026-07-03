import { describe, it, expect } from 'vitest';
import { generatePfEsiWage } from '../generators/pf-esi-wage.generator';
import type { PfEsiWageRow, StatutoryMeta } from '../types/statutory.types';

function meta(): StatutoryMeta {
  return { workspaceId: 'ws1', workspaceName: 'Acme', from: '2026-04-01', to: '2026-04-30', generatedAt: new Date() };
}

describe('generatePfEsiWage', () => {
  it('returns xlsx buffer with PK zip header (xlsx is a zip)', () => {
    const rows: PfEsiWageRow[] = [{
      memberId: 'm1', name: 'Rahul', employeeCode: 'E1',
      uan: '123456789012', esiIpNumber: null,
      grossWages: 25000, epfWages: 15000, epsWages: 15000, edliWages: 15000,
      employeeEpfContribution: 1800, employerEpsContribution: 1250, employerEpfDifference: 550,
      ncpDays: 0, refundOfAdvances: 0,
      employeeEsiContribution: 0, employerEsiContribution: 0, esiApplicable: false,
    }];
    const buf = generatePfEsiWage(rows, meta());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 2).toString()).toBe('PK');   // xlsx is zip
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('handles empty row list (returns valid empty workbook)', () => {
    const buf = generatePfEsiWage([], meta());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
