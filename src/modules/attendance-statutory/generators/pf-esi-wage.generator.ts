import * as XLSX from 'xlsx';
import type { PfEsiWageRow, StatutoryMeta } from '../types/statutory.types';

/**
 * PF/ESI-ready wage register Excel.
 * Produces a single .xlsx workbook with two sheets:
 *   1. "PF-ECR"  — EPFO ECR 2.0 format, 11 columns
 *   2. "ESI"     — ESI ECR format, 7 columns (only members with esiApplicable=true)
 *
 * Math is pre-computed upstream in StatutoryDataService.buildPfEsiRows (G-02),
 * which mirrors ComplianceExportService.buildEcrData (salary module).
 * This generator only serialises numbers into cells — no math.
 *
 * Per G-RESEARCH §PF/ESI Wage Register (HIGH confidence):
 *   PF ceiling Rs.15,000; ESI ceiling Rs.21,000 (applied in buildPfEsiRows)
 *
 * T-G04-02 (formula injection): XLSX.utils.aoa_to_sheet treats string cells as
 * literal text and does not evaluate formula strings. Member names are also
 * uppercased+trimmed which helps strip leading = prefixes in practice.
 */
export function generatePfEsiWage(
  rows: PfEsiWageRow[],
  meta: StatutoryMeta,
): Buffer {
  const wb = XLSX.utils.book_new();

  // ===== Sheet 1: PF-ECR (EPFO ECR 2.0 — 11 columns) =====
  const ecrHeader = [
    'UAN',
    'Member Name',
    'Gross Wages',
    'EPF Wages',
    'EPS Wages',
    'EDLI Wages',
    'Employee EPF Contribution (12%)',
    'Employer EPS Contribution (8.33%, cap Rs.1250)',
    'Employer EPF Difference',
    'NCP Days',
    'Refund of Advances',
  ];
  const ecrMeta = [
    [`Establishment: ${meta.workspaceName}`],
    [`Period: ${meta.from} to ${meta.to}`],
    [`Generated: ${meta.generatedAt.toISOString()}${meta.generatedByName ? ' by ' + meta.generatedByName : ''}`],
    [],  // blank spacer
  ];
  const ecrRows = rows
    .filter((r) => r.uan && r.uan.trim().length > 0)   // ECR requires UAN
    .map((r) => [
      r.uan,
      (r.name || '').toUpperCase().trim(),
      r.grossWages,
      r.epfWages,
      r.epsWages,
      r.edliWages,
      r.employeeEpfContribution,
      r.employerEpsContribution,
      r.employerEpfDifference,
      r.ncpDays,
      r.refundOfAdvances,
    ]);
  const ecrData = [...ecrMeta, ecrHeader, ...ecrRows];
  const ecrSheet = XLSX.utils.aoa_to_sheet(ecrData);
  // Column widths (wch units ≈ characters)
  ecrSheet['!cols'] = [
    { wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ecrSheet, 'PF-ECR');

  // ===== Sheet 2: ESI (7 columns, only esiApplicable members) =====
  const esiHeader = [
    'ESI IP Number',
    'Employee Name',
    'Gross Salary',
    'Employee Contribution (0.75%)',
    'Employer Contribution (3.25%)',
    'Total Contribution',
    'Reason Code',
  ];
  const esiMeta = [
    [`Establishment: ${meta.workspaceName}`],
    [`Period: ${meta.from} to ${meta.to}`],
    ['ESI ceiling (gross <= Rs.21,000)'],
    [],
  ];
  const esiRows = rows
    .filter((r) => r.esiApplicable)
    .map((r) => [
      r.esiIpNumber ?? '',
      (r.name || '').toUpperCase().trim(),
      r.grossWages,
      r.employeeEsiContribution,
      r.employerEsiContribution,
      r.employeeEsiContribution + r.employerEsiContribution,
      '',   // Reason Code left blank — used for exits/absence codes only
    ]);
  const esiData = [...esiMeta, esiHeader, ...esiRows];
  const esiSheet = XLSX.utils.aoa_to_sheet(esiData);
  esiSheet['!cols'] = [
    { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, esiSheet, 'ESI');

  // Write to Buffer
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return buffer;
}
