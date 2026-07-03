import * as XLSX from 'xlsx';
import { NormalisedRow } from './normalised-row';

const ETIMETRACK_SHEET_NAMES = new Set([
  'Attendance Report',
  'AttendanceReport',
  'Att Report',
  'Employee Attendance',
  'Sheet1',
]);

const EMP_CODE_HEADERS = ['Emp Code', 'EmpCode', 'Employee Code'];

/**
 * Detect: extension .xls/.xlsx AND (sheet name in known list OR row-0 has Emp Code variant).
 */
export function isETimeTrack(buffer: Buffer, originalName: string): boolean {
  const ext = originalName.toLowerCase();
  if (!ext.endsWith('.xls') && !ext.endsWith('.xlsx')) return false;
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0] ?? '';
    if (ETIMETRACK_SHEET_NAMES.has(sheetName)) return true;
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return false;
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      raw: false,
      dateNF: 'YYYY-MM-DD HH:MM:SS',
      header: 1,
    });
    const headers: string[] = (rows[0] ?? []).map(String);
    return EMP_CODE_HEADERS.some((h) => headers.includes(h));
  } catch {
    return false;
  }
}

/**
 * Parse eTimeTrackLite XLS/XLSX buffer into NormalisedRows.
 * Multi-punch row: both In Time + Out Time present → generate 2 events.
 * Single-punch row: only one time column or a Direction/InOut column → 1 event.
 */
export function parseETimeTrackXls(buffer: Buffer): NormalisedRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
    raw: false,
    dateNF: 'YYYY-MM-DD HH:MM:SS',
  });

  const results: NormalisedRow[] = [];

  for (const row of rows) {
    const empCode =
      row['Emp Code'] ?? row['EmpCode'] ?? row['Employee Code'] ?? '';
    const dateStr = row['Date'] ?? row['Att Date'] ?? '';
    const inTime = row['In Time'] ?? row['InTime'] ?? row['Punch In'] ?? '';
    const outTime = row['Out Time'] ?? row['OutTime'] ?? row['Punch Out'] ?? '';

    if (!empCode || !dateStr) continue;

    // Multi-punch consolidated row — In Time
    if (inTime) {
      const ts = new Date(`${dateStr} ${inTime}`);
      if (!isNaN(ts.getTime())) {
        results.push({
          deviceUserId: String(empCode),
          timestamp: ts,
          punchType: 'CHECK_IN',
          verifyMethod: null,
        });
      }
    }

    // Multi-punch consolidated row — Out Time
    if (outTime) {
      const ts = new Date(`${dateStr} ${outTime}`);
      if (!isNaN(ts.getTime())) {
        results.push({
          deviceUserId: String(empCode),
          timestamp: ts,
          punchType: 'CHECK_OUT',
          verifyMethod: null,
        });
      }
    }
  }

  return results;
}
