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
// ICICI Bank — CSV/XLSX statement parser
// ---------------------------------------------------------------------------

/**
 * Known ICICI column header signatures.
 * ICICI has two variants depending on the download mode (retail vs corporate net banking).
 *
 * Variant A (retail net banking):
 *   Tran Date | Value Date | Particulars | Location | Chq.No | Withdrawals | Deposits | Balance (INR)
 *
 * Variant B (corporate / iMobile):
 *   Transaction Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance
 */
export const ICICI_SIGNATURES: string[][] = [
  [
    'Tran Date',
    'Value Date',
    'Particulars',
    'Location',
    'Chq.No',
    'Withdrawals',
    'Deposits',
    'Balance (INR)',
  ],
  [
    'Transaction Date',
    'Value Date',
    'Description',
    'Ref No./Cheque No.',
    'Debit',
    'Credit',
    'Balance',
  ],
];

/**
 * Return true if `headers` matches either ICICI signature (case-insensitive).
 */
export function detectIcici(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return ICICI_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Determine which ICICI variant a header row matches.
 * Returns 'A' for the Tran Date / Particulars variant,
 *         'B' for the Transaction Date / Description variant,
 *         null if neither matches.
 */
function detectIciVariant(
  headers: string[],
): 'A' | 'B' | null {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  const sigA = ICICI_SIGNATURES[0];
  const sigB = ICICI_SIGNATURES[1];
  if (sigA.every((col) => normalised.includes(col.toLowerCase().trim()))) {
    return 'A';
  }
  if (sigB.every((col) => normalised.includes(col.toLowerCase().trim()))) {
    return 'B';
  }
  return null;
}

/**
 * Parse an ICICI bank statement buffer (CSV or XLSX).
 * Handles BOTH header variants:
 *
 * Variant A mapping:
 *   Tran Date     → txnDate
 *   Value Date    → valueDate
 *   Particulars   → narration
 *   Chq.No        → refNumber
 *   Withdrawals   → debitPaise
 *   Deposits      → creditPaise
 *   Balance (INR) → closingBalancePaise
 *
 * Variant B mapping:
 *   Transaction Date    → txnDate
 *   Value Date          → valueDate
 *   Description         → narration
 *   Ref No./Cheque No.  → refNumber
 *   Debit               → debitPaise
 *   Credit              → creditPaise
 *   Balance             → closingBalancePaise
 */
export function parseIcici(buffer: Buffer, filename: string): ParseResult {
  const fileType = detectFileType(filename);
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  const warnings: string[] = [];

  // Scan for header row (up to first 12 rows)
  let headerRowIndex = -1;
  let variant: 'A' | 'B' | null = null;

  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    const v = detectIciVariant(cells);
    if (v !== null) {
      headerRowIndex = i;
      variant = v;
      break;
    }
  }

  if (headerRowIndex === -1 || variant === null) {
    return {
      rows: [],
      detectedFormat: 'icici',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['ICICI: header row not found within first 12 rows'],
    };
  }

  const headerCells = (rows[headerRowIndex] ?? []).map((c) =>
    String(c ?? '').trim(),
  );
  const colIndex = (name: string): number =>
    headerCells.findIndex(
      (h) => h.toLowerCase() === name.toLowerCase(),
    );

  // Map column names based on variant
  const idxDate =
    variant === 'A' ? colIndex('Tran Date') : colIndex('Transaction Date');
  const idxValueDate = colIndex('Value Date');
  const idxNarration =
    variant === 'A' ? colIndex('Particulars') : colIndex('Description');
  const idxRef =
    variant === 'A'
      ? colIndex('Chq.No')
      : colIndex('Ref No./Cheque No.');
  const idxDebit =
    variant === 'A' ? colIndex('Withdrawals') : colIndex('Debit');
  const idxCredit =
    variant === 'A' ? colIndex('Deposits') : colIndex('Credit');
  const idxClosing =
    variant === 'A' ? colIndex('Balance (INR)') : colIndex('Balance');

  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string => String(row[idx] ?? '').trim();

    const rawNarration = get(idxNarration);
    const rawDebit = get(idxDebit);
    const rawCredit = get(idxCredit);

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

    // Skip empty rows
    if (debitPaise === 0 && creditPaise === 0 && rawNarration === '') {
      continue;
    }

    let txnDate: Date;
    try {
      txnDate = parseDate(get(idxDate) || null);
    } catch {
      warnings.push(
        `Row ${i}: skipped — cannot parse date: ${get(idxDate)}`,
      );
      continue;
    }

    let valueDate: Date | undefined;
    const rawValueDt = get(idxValueDate);
    if (rawValueDt) {
      try {
        valueDate = parseDate(rawValueDt);
      } catch {
        // optional
      }
    }

    let closingBalancePaise: number | undefined;
    const rawClosing = get(idxClosing);
    if (rawClosing) {
      try {
        closingBalancePaise = parsePaise(rawClosing);
      } catch {
        // optional
      }
    }

    const amountPaise = creditPaise - debitPaise;
    const narration = stripCsvFormulaPrefix(rawNarration);
    const refNumber = get(idxRef) || undefined;

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
    detectedFormat: 'icici',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
