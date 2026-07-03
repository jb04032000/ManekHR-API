import {
  bufferToCsvLines,
  detectFileType,
  parseDate,
  parsePaise,
  readXlsxAsRows,
  stripCsvFormulaPrefix,
} from './parse-utils';
import { NormalisedRow, ParseResult } from './normalised-row';

// ---------------------------------------------------------------------------
// HDFC Bank — CSV/XLSX statement parser
// ---------------------------------------------------------------------------

/**
 * Known HDFC column header signatures.
 * HDFC CSV exports may have 1 metadata row above the header row.
 * HDFC CSV files carry a UTF-8 BOM — stripped by bufferToCsvLines/stripBom.
 *
 * Columns: Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
 */
export const HDFC_SIGNATURES: string[][] = [
  [
    'Date',
    'Narration',
    'Chq./Ref.No.',
    'Value Dt',
    'Withdrawal Amt.',
    'Deposit Amt.',
    'Closing Balance',
  ],
];

/**
 * Return true if `headers` matches any HDFC signature (case-insensitive, trimmed).
 */
export function detectHdfc(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return HDFC_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Parse an HDFC bank statement buffer (CSV or XLSX).
 *
 * Column mapping:
 *   Date            → txnDate
 *   Narration       → narration
 *   Chq./Ref.No.    → refNumber
 *   Value Dt        → valueDate
 *   Withdrawal Amt. → debitPaise
 *   Deposit Amt.    → creditPaise
 *   Closing Balance → closingBalancePaise
 *
 * Trailer rows (both debit and credit are 0 AND narration is empty) are skipped.
 */
export function parseHdfc(buffer: Buffer, filename: string): ParseResult {
  const fileType = detectFileType(filename);
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  const warnings: string[] = [];

  // Scan for header row (up to first 12 rows — HDFC has at most 1 metadata row)
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    if (detectHdfc(cells)) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return {
      rows: [],
      detectedFormat: 'hdfc',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['HDFC: header row not found within first 12 rows'],
    };
  }

  // Build column index map from header row
  const headerCells = (rows[headerRowIndex] ?? []).map((c) =>
    String(c ?? '').trim(),
  );
  const colIndex = (name: string): number =>
    headerCells.findIndex(
      (h) => h.toLowerCase() === name.toLowerCase(),
    );

  const idxDate = colIndex('Date');
  const idxNarration = colIndex('Narration');
  const idxRef = colIndex('Chq./Ref.No.');
  const idxValueDt = colIndex('Value Dt');
  const idxWithdrawal = colIndex('Withdrawal Amt.');
  const idxDeposit = colIndex('Deposit Amt.');
  const idxClosing = colIndex('Closing Balance');

  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string => String(row[idx] ?? '').trim();

    const rawNarration = get(idxNarration);
    const rawDebit = get(idxWithdrawal);
    const rawCredit = get(idxDeposit);

    // Skip trailer rows: empty narration + zero amounts
    let debitPaise = 0;
    let creditPaise = 0;
    try {
      debitPaise = parsePaise(rawDebit || null);
    } catch {
      warnings.push(`Row ${i}: skipped — cannot parse debit: ${rawDebit}`);
      continue;
    }
    try {
      creditPaise = parsePaise(rawCredit || null);
    } catch {
      warnings.push(`Row ${i}: skipped — cannot parse credit: ${rawCredit}`);
      continue;
    }

    if (debitPaise === 0 && creditPaise === 0 && rawNarration === '') {
      continue;
    }

    // Parse transaction date
    let txnDate: Date;
    try {
      txnDate = parseDate(get(idxDate) || null);
    } catch {
      warnings.push(`Row ${i}: skipped — cannot parse date: ${get(idxDate)}`);
      continue;
    }

    // Parse value date (optional — ignore parse errors)
    let valueDate: Date | undefined;
    const rawValueDt = get(idxValueDt);
    if (rawValueDt) {
      try {
        valueDate = parseDate(rawValueDt);
      } catch {
        // value date is optional; skip without warning
      }
    }

    // Parse closing balance
    let closingBalancePaise: number | undefined;
    const rawClosing = get(idxClosing);
    if (rawClosing) {
      try {
        closingBalancePaise = parsePaise(rawClosing);
      } catch {
        // optional field
      }
    }

    const amountPaise = creditPaise - debitPaise;
    const narration = stripCsvFormulaPrefix(rawNarration);
    const refNumber = get(idxRef) || undefined;

    // Compute opening balance from first row
    if (normalisedRows.length === 0 && closingBalancePaise !== undefined) {
      openingBalancePaise = closingBalancePaise - amountPaise;
    }

    normalisedRows.push({
      rowIndex: normalisedRows.length,
      txnDate,
      valueDate,
      narration,
      refNumber,
      debitPaise,
      creditPaise,
      amountPaise,
      closingBalancePaise,
    });
  }

  const dates = normalisedRows.map((r) => r.txnDate.getTime());
  const statementDateFrom =
    dates.length > 0 ? new Date(Math.min(...dates)) : null;
  const statementDateTo =
    dates.length > 0 ? new Date(Math.max(...dates)) : null;

  const lastRow = normalisedRows[normalisedRows.length - 1];
  const closingBalancePaise = lastRow?.closingBalancePaise ?? null;

  return {
    rows: normalisedRows,
    detectedFormat: 'hdfc',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
