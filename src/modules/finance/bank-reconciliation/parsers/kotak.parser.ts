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
// Kotak Mahindra Bank — CSV/XLSX statement parser
// ---------------------------------------------------------------------------

/**
 * Known Kotak column header signatures.
 * Kotak offers two CSV export variants:
 *   Variant A: full column names with "Transaction Date", "Chq / Ref number"
 *   Variant B: abbreviated "Date", "Ref / Chq No", "DR", "CR"
 */
export const KOTAK_SIGNATURES: string[][] = [
  ['Transaction Date', 'Description', 'Chq / Ref number', 'Debit', 'Credit', 'Balance'],
  ['Date', 'Description', 'Ref / Chq No', 'DR', 'CR', 'Balance'],
];

/**
 * Return true if `headers` matches any Kotak signature (case-insensitive, trimmed).
 */
export function detectKotak(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return KOTAK_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Parse a Kotak Mahindra Bank statement buffer (CSV or XLSX).
 *
 * Column mapping (Variant A):
 *   Transaction Date → txnDate
 *   Description      → narration
 *   Chq / Ref number → refNumber
 *   Debit            → debitPaise
 *   Credit           → creditPaise
 *   Balance          → closingBalancePaise
 *
 * Column mapping (Variant B):
 *   Date             → txnDate
 *   Description      → narration
 *   Ref / Chq No     → refNumber
 *   DR               → debitPaise
 *   CR               → creditPaise
 *   Balance          → closingBalancePaise
 */
export function parseKotak(buffer: Buffer, filename: string): ParseResult {
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
    if (detectKotak(cells)) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return {
      rows: [],
      detectedFormat: 'kotak',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['Kotak: header row not found within first 12 rows'],
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

  // Detect which variant based on presence of "Transaction Date"
  const isVariantA = colIndex('Transaction Date') !== -1;

  const idxDate = isVariantA ? colIndex('Transaction Date') : colIndex('Date');
  const idxNarration = colIndex('Description');
  const idxRef = isVariantA ? colIndex('Chq / Ref number') : colIndex('Ref / Chq No');
  const idxDebit = isVariantA ? colIndex('Debit') : colIndex('DR');
  const idxCredit = isVariantA ? colIndex('Credit') : colIndex('CR');
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
    const refNumber = idxRef !== -1 ? (get(idxRef) || undefined) : undefined;

    // Compute opening balance from first row
    if (normalisedRows.length === 0 && closingBalancePaise !== undefined) {
      openingBalancePaise = closingBalancePaise - amountPaise;
    }

    normalisedRows.push({
      rowIndex: normalisedRows.length,
      txnDate,
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
    detectedFormat: 'kotak',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
