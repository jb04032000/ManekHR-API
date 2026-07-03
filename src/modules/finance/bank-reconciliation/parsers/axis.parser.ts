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
// Axis Bank — CSV/XLSX statement parser
// ---------------------------------------------------------------------------

/**
 * Known Axis Bank column header signatures.
 * Axis includes 3-5 metadata lines of account info before the header row.
 * Axis sometimes downloads as XLSX.
 *
 * Variant A (DR/CR flag style — short column names):
 *   Tran Date | CHQNO | PARTICULARS | DR | CR | BAL
 *
 * Variant B (split-column style — descriptive column names):
 *   Transaction Date | Transaction Remarks | Debit Amount | Credit Amount | Balance
 */
export const AXIS_SIGNATURES: string[][] = [
  ['Tran Date', 'CHQNO', 'PARTICULARS', 'DR', 'CR', 'BAL'],
  [
    'Transaction Date',
    'Transaction Remarks',
    'Debit Amount',
    'Credit Amount',
    'Balance',
  ],
];

/**
 * Return true if `headers` matches either Axis signature (case-insensitive).
 */
export function detectAxis(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return AXIS_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Determine which Axis variant a header row matches.
 * Returns 'A' for the CHQNO/DR/CR/BAL variant,
 *         'B' for the split-column Debit Amount/Credit Amount variant,
 *         null if neither matches.
 */
function detectAxisVariant(headers: string[]): 'A' | 'B' | null {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  const sigA = AXIS_SIGNATURES[0];
  const sigB = AXIS_SIGNATURES[1];
  if (sigA.every((col) => normalised.includes(col.toLowerCase().trim()))) {
    return 'A';
  }
  if (sigB.every((col) => normalised.includes(col.toLowerCase().trim()))) {
    return 'B';
  }
  return null;
}

/**
 * Parse an Axis Bank statement buffer (CSV or XLSX).
 * Handles BOTH header variants.
 *
 * Axis includes 3-5 metadata lines before the header row — scan all rows
 * (up to 12) to find the header signature.
 *
 * Variant A (DR/CR style) column mapping:
 *   Tran Date    → txnDate
 *   CHQNO        → refNumber
 *   PARTICULARS  → narration
 *   DR           → debitPaise  (DR column contains debit amounts)
 *   CR           → creditPaise (CR column contains credit amounts)
 *   BAL          → closingBalancePaise
 *
 * Variant B (split-column style) column mapping:
 *   Transaction Date    → txnDate
 *   Transaction Remarks → narration
 *   Debit Amount        → debitPaise
 *   Credit Amount       → creditPaise
 *   Balance             → closingBalancePaise
 *
 * Mid-row parse errors are collected into `warnings` and the row is skipped
 * (errors are NOT thrown — the function always returns a complete ParseResult).
 */
export function parseAxis(buffer: Buffer, filename: string): ParseResult {
  const fileType = detectFileType(filename);
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  const warnings: string[] = [];

  // Scan up to first 12 rows — Axis includes 3-5 metadata lines (RESEARCH §1.5)
  let headerRowIndex = -1;
  let variant: 'A' | 'B' | null = null;

  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    const v = detectAxisVariant(cells);
    if (v !== null) {
      headerRowIndex = i;
      variant = v;
      break;
    }
  }

  if (headerRowIndex === -1 || variant === null) {
    return {
      rows: [],
      detectedFormat: 'axis',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['Axis: header row not found within first 12 rows'],
    };
  }

  const headerCells = (rows[headerRowIndex] ?? []).map((c) =>
    String(c ?? '').trim(),
  );
  const colIndex = (name: string): number =>
    headerCells.findIndex(
      (h) => h.toLowerCase() === name.toLowerCase(),
    );

  // Variant-dependent column indices
  const idxDate =
    variant === 'A' ? colIndex('Tran Date') : colIndex('Transaction Date');
  const idxNarration =
    variant === 'A' ? colIndex('PARTICULARS') : colIndex('Transaction Remarks');
  const idxRef = variant === 'A' ? colIndex('CHQNO') : -1;
  const idxDebit =
    variant === 'A' ? colIndex('DR') : colIndex('Debit Amount');
  const idxCredit =
    variant === 'A' ? colIndex('CR') : colIndex('Credit Amount');
  const idxClosing = variant === 'A' ? colIndex('BAL') : colIndex('Balance');

  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string =>
      idx >= 0 ? String(row[idx] ?? '').trim() : '';

    const rawNarration = get(idxNarration);
    const rawDebit = get(idxDebit);
    const rawCredit = get(idxCredit);

    let debitPaise = 0;
    let creditPaise = 0;
    try {
      debitPaise = parsePaise(rawDebit || null);
    } catch {
      warnings.push(`Row ${i} skipped: cannot parse debit amount: ${rawDebit}`);
      continue;
    }
    try {
      creditPaise = parsePaise(rawCredit || null);
    } catch {
      warnings.push(`Row ${i} skipped: cannot parse credit amount: ${rawCredit}`);
      continue;
    }

    // Skip empty rows (no narration + zero amounts)
    if (debitPaise === 0 && creditPaise === 0 && rawNarration === '') {
      continue;
    }

    // Parse transaction date — skip row on failure (collect warning, continue)
    let txnDate: Date;
    try {
      txnDate = parseDate(get(idxDate) || null);
    } catch {
      warnings.push(
        `Row ${i} skipped: cannot parse date: ${get(idxDate)}`,
      );
      continue;
    }

    // Parse closing balance (optional)
    let closingBalancePaise: number | undefined;
    const rawClosing = get(idxClosing);
    if (rawClosing) {
      try {
        closingBalancePaise = parsePaise(rawClosing);
      } catch {
        // optional — no warning needed
      }
    }

    const amountPaise = creditPaise - debitPaise;
    const narration = stripCsvFormulaPrefix(rawNarration);
    const refNumber = idxRef >= 0 ? get(idxRef) || undefined : undefined;

    // Compute opening balance from first data row
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
    detectedFormat: 'axis',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
