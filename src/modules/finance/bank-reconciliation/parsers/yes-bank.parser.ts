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
// YES Bank — CSV/XLSX statement parser
// ---------------------------------------------------------------------------

/**
 * Known YES Bank column header signatures.
 * YES Bank uses a single CSV export variant with value date and split
 * withdrawal/deposit columns.
 */
export const YES_BANK_SIGNATURES: string[][] = [
  [
    'Date',
    'Narration',
    'Ref No / Chq No',
    'Value Date',
    'Withdrawal Amt',
    'Deposit Amt',
    'Closing Balance',
  ],
];

/**
 * Return true if `headers` matches any YES Bank signature (case-insensitive, trimmed).
 */
export function detectYesBank(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return YES_BANK_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Parse a YES Bank statement buffer (CSV or XLSX).
 *
 * Column mapping:
 *   Date             → txnDate
 *   Narration        → narration
 *   Ref No / Chq No  → refNumber
 *   Value Date       → valueDate
 *   Withdrawal Amt   → debitPaise
 *   Deposit Amt      → creditPaise
 *   Closing Balance  → closingBalancePaise
 */
export function parseYesBank(buffer: Buffer, filename: string): ParseResult {
  const fileType = detectFileType(filename);
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  const warnings: string[] = [];

  // Scan for header row (up to 12 rows)
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    if (detectYesBank(cells)) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return {
      rows: [],
      detectedFormat: 'yes_bank',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['YES Bank: header row not found within first 12 rows'],
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
  const idxRef = colIndex('Ref No / Chq No');
  const idxValueDate = colIndex('Value Date');
  const idxWithdrawal = colIndex('Withdrawal Amt');
  const idxDeposit = colIndex('Deposit Amt');
  const idxClosing = colIndex('Closing Balance');

  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string => String(row[idx] ?? '').trim();

    const rawNarration = get(idxNarration);
    const rawDebit = get(idxWithdrawal);
    const rawCredit = get(idxDeposit);

    // Parse debit
    let debitPaise = 0;
    try {
      debitPaise = parsePaise(rawDebit || null);
    } catch {
      warnings.push(`Row ${i}: skipped — cannot parse debit: ${rawDebit}`);
      continue;
    }

    // Parse credit
    let creditPaise = 0;
    try {
      creditPaise = parsePaise(rawCredit || null);
    } catch {
      warnings.push(`Row ${i}: skipped — cannot parse credit: ${rawCredit}`);
      continue;
    }

    // Skip empty/trailer rows
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

    // Parse value date (optional)
    let valueDate: Date | undefined;
    const rawValueDate = get(idxValueDate);
    if (rawValueDate) {
      try {
        valueDate = parseDate(rawValueDate);
      } catch {
        // value date is optional; skip without warning
      }
    }

    // Parse closing balance (optional)
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
    detectedFormat: 'yes_bank',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
