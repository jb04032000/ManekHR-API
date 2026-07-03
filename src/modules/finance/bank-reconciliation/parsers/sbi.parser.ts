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
// SBI (State Bank of India) — XLS/CSV statement parser
// ---------------------------------------------------------------------------

/**
 * Known SBI column header signatures.
 * SBI typically downloads as XLS (Excel 97-2003) but may also export CSV.
 *
 * SBI XLS files include 2-8 metadata rows above the actual column header row:
 *   - Account Number
 *   - Account Name
 *   - Branch / IFSC
 *   - Statement period
 *
 * Implementation: scan all rows until we detect the header signature; skip
 * all metadata rows above it.
 *
 * Variant A (standard retail export):
 *   Txn Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance
 *
 * Variant B (older/passbook export):
 *   Date | Description | Ref No. | Debit | Credit | Balance
 */
export const SBI_SIGNATURES: string[][] = [
  [
    'Txn Date',
    'Value Date',
    'Description',
    'Ref No./Cheque No.',
    'Debit',
    'Credit',
    'Balance',
  ],
  ['Date', 'Description', 'Ref No.', 'Debit', 'Credit', 'Balance'],
];

/**
 * Return true if `headers` matches either SBI signature (case-insensitive).
 */
export function detectSbi(headers: string[]): boolean {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  return SBI_SIGNATURES.some((sig) => {
    if (sig.length > normalised.length) return false;
    return sig.every((col) => normalised.includes(col.toLowerCase().trim()));
  });
}

/**
 * Determine which SBI variant a header row matches.
 * Returns 'A' for the Txn Date / Ref No./Cheque No. variant,
 *         'B' for the Date / Ref No. variant,
 *         null if neither matches.
 */
function detectSbiVariant(headers: string[]): 'A' | 'B' | null {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  const sigA = SBI_SIGNATURES[0];
  const sigB = SBI_SIGNATURES[1];
  if (sigA.every((col) => normalised.includes(col.toLowerCase().trim()))) {
    return 'A';
  }
  if (sigB.every((col) => normalised.includes(col.toLowerCase().trim()))) {
    return 'B';
  }
  return null;
}

/**
 * Parse an SBI bank statement buffer (XLS/XLSX or CSV).
 *
 * Key behaviour:
 * - Scans ALL rows to find the header row (handles 2-8 metadata rows before table).
 * - Data rows follow the header until the first empty row or a row whose date
 *   cell cannot be parsed (catch on parseDate failure → break the loop, not throw).
 * - Uses parsePaise and parseDate from parse-utils.
 *
 * Column mapping (Variant A):
 *   Txn Date           → txnDate
 *   Value Date         → valueDate
 *   Description        → narration
 *   Ref No./Cheque No. → refNumber
 *   Debit              → debitPaise
 *   Credit             → creditPaise
 *   Balance            → closingBalancePaise
 *
 * Column mapping (Variant B):
 *   Date        → txnDate
 *   Description → narration
 *   Ref No.     → refNumber
 *   Debit       → debitPaise
 *   Credit      → creditPaise
 *   Balance     → closingBalancePaise
 */
export function parseSbi(buffer: Buffer, filename: string): ParseResult {
  const fileType = detectFileType(filename);
  // XLS-first: SBI primarily downloads as XLS; CSV also supported
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  const warnings: string[] = [];

  // Scan ALL rows for header signature to skip SBI metadata rows
  let headerRowIndex = -1;
  let variant: 'A' | 'B' | null = null;

  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    const v = detectSbiVariant(cells);
    if (v !== null) {
      headerRowIndex = i;
      variant = v;
      break;
    }
  }

  if (headerRowIndex === -1 || variant === null) {
    return {
      rows: [],
      detectedFormat: 'sbi',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['SBI: header row not found (scanned all rows for signature, none matched)'],
    };
  }

  const headerCells = (rows[headerRowIndex] ?? []).map((c) =>
    String(c ?? '').trim(),
  );
  const colIndex = (name: string): number =>
    headerCells.findIndex(
      (h) => h.toLowerCase() === name.toLowerCase(),
    );

  const idxDate = variant === 'A' ? colIndex('Txn Date') : colIndex('Date');
  const idxValueDate = variant === 'A' ? colIndex('Value Date') : -1;
  const idxNarration = colIndex('Description');
  const idxRef =
    variant === 'A'
      ? colIndex('Ref No./Cheque No.')
      : colIndex('Ref No.');
  const idxDebit = colIndex('Debit');
  const idxCredit = colIndex('Credit');
  const idxClosing = colIndex('Balance');

  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string =>
      idx >= 0 ? String(row[idx] ?? '').trim() : '';

    // SBI data rows end at the first empty row (all cells empty)
    const allEmpty = row.every((c) => String(c ?? '').trim() === '');
    if (allEmpty) break;

    const rawDate = get(idxDate);
    const rawNarration = get(idxNarration);
    const rawDebit = get(idxDebit);
    const rawCredit = get(idxCredit);

    // Parse date — on failure, stop the data loop (SBI footer rows don't have parseable dates)
    let txnDate: Date;
    try {
      txnDate = parseDate(rawDate || null);
    } catch {
      // Break on first unparseable date — likely footer/summary row
      break;
    }

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

    let valueDate: Date | undefined;
    if (idxValueDate >= 0) {
      const rawValueDt = get(idxValueDate);
      if (rawValueDt) {
        try {
          valueDate = parseDate(rawValueDt);
        } catch {
          // optional
        }
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
    detectedFormat: 'sbi',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
