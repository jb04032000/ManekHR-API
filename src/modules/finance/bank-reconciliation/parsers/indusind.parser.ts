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
// IndusInd Bank — CSV/XLSX statement parser
// ---------------------------------------------------------------------------

/**
 * Known IndusInd column header signatures.
 * IndusInd uses split Amount(DR)/Amount(CR) columns with a value date column.
 */
export const INDUSIND_SIGNATURES: string[][] = [
  [
    'Date',
    'Description',
    'Cheque Number',
    'Value Date',
    'Amount(DR)',
    'Amount(CR)',
    'Balance',
  ],
];

/**
 * Return true if `headers` matches any IndusInd signature (case-insensitive, trimmed).
 */
export function detectIndusind(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return INDUSIND_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Parse an IndusInd Bank statement buffer (CSV or XLSX).
 *
 * Column mapping:
 *   Date          → txnDate
 *   Description   → narration
 *   Cheque Number → refNumber
 *   Value Date    → valueDate
 *   Amount(DR)    → debitPaise
 *   Amount(CR)    → creditPaise
 *   Balance       → closingBalancePaise
 */
export function parseIndusind(buffer: Buffer, filename: string): ParseResult {
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
    if (detectIndusind(cells)) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return {
      rows: [],
      detectedFormat: 'indusind',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['IndusInd: header row not found within first 12 rows'],
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
  const idxNarration = colIndex('Description');
  const idxRef = colIndex('Cheque Number');
  const idxValueDate = colIndex('Value Date');
  const idxDebit = colIndex('Amount(DR)');
  const idxCredit = colIndex('Amount(CR)');
  const idxClosing = colIndex('Balance');

  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string => String(row[idx] ?? '').trim();

    const rawNarration = get(idxNarration);
    const rawDebit = get(idxDebit);
    const rawCredit = get(idxCredit);

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
    detectedFormat: 'indusind',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
