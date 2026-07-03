import { BadRequestException } from '@nestjs/common';
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
// Generic (fallback) — configurable column-mapping parser
// ---------------------------------------------------------------------------

/**
 * Column mapping configuration supplied by the user via the column-mapping wizard.
 * Each property is a header name (string) OR a 0-based numeric column index
 * expressed as a string (e.g. '2' means third column).
 *
 * Amount interpretation (exactly one branch must be provided):
 *   1. debitColumn + creditColumn   — split debit/credit columns (most common)
 *   2. amountColumn + drCrFlagColumn — single amount + DR/CR flag column
 *   3. amountColumn alone           — signed amount (positive = credit, negative = debit)
 *
 * If none of the above is satisfiable, parseGeneric throws BadRequestException
 * BEFORE the data loop (Threat T-13-W2-06: validated server-side).
 */
export interface GenericColumnMapping {
  /** Header name or 0-based numeric index as string for the transaction date column. */
  dateColumn: string;

  /** Header name or 0-based numeric index as string for the narration/description column. */
  narrationColumn: string;

  /** Debit column — use with creditColumn for split-column approach. */
  debitColumn?: string;

  /** Credit column — use with debitColumn for split-column approach. */
  creditColumn?: string;

  /**
   * Single amount column. Combined with drCrFlagColumn for amount+flag approach,
   * or used alone for signed amount approach.
   */
  amountColumn?: string;

  /**
   * DR/CR flag column. If a cell contains 'DR' (case-insensitive), the amount
   * is treated as a debit. If it contains 'CR', it is treated as a credit.
   */
  drCrFlagColumn?: string;

  /** Optional reference/cheque number column. */
  refNumberColumn?: string;

  /** Optional running balance column. */
  balanceColumn?: string;

  /** Optional value date column (settlement date, distinct from transaction date). */
  valueDateColumn?: string;

  /**
   * 0-based row index of the header row.
   * If omitted, auto-detected: the first row where ALL mandatory mapped
   * columns resolve to a non-empty header cell.
   */
  headerRowIndex?: number;
}

/**
 * Resolve a column reference from the mapping to a 0-based index.
 * If the reference is a numeric string (e.g. '2'), treat it directly as index.
 * Otherwise perform a case-insensitive header name lookup.
 */
function resolveColumnIndex(
  ref: string,
  headerCells: string[],
): number {
  // Numeric reference: column index directly
  if (/^\d+$/.test(ref.trim())) {
    return parseInt(ref.trim(), 10);
  }
  // Header name lookup (case-insensitive)
  return headerCells.findIndex(
    (h) => h.toLowerCase() === ref.toLowerCase().trim(),
  );
}

/**
 * Auto-detect the header row index by finding the first row where ALL provided
 * mandatory column names exist in the row (case-insensitive). Numeric column
 * references are skipped in auto-detection (any row satisfies a numeric ref).
 */
function autoDetectHeaderRow(
  rows: unknown[][],
  mandatoryRefs: string[],
): number {
  // Filter to only name-based refs (numeric refs don't constrain header detection)
  const nameRefs = mandatoryRefs.filter((r) => !/^\d+$/.test(r.trim()));

  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
    const allPresent = nameRefs.every((ref) =>
      cells.includes(ref.toLowerCase().trim()),
    );
    if (allPresent) return i;
  }
  return -1;
}

/**
 * Parse a bank statement buffer using an explicit column mapping.
 * Serves as the fallback when no known bank format is detected.
 *
 * Three amount-column branches (checked in priority order):
 *   1. debitColumn AND creditColumn   — split debit/credit
 *   2. amountColumn AND drCrFlagColumn — amount + DR/CR indicator
 *   3. amountColumn alone              — signed amount
 *
 * Throws BadRequestException (before the data loop) if none can be satisfied.
 *
 * Column references may be header names or 0-based numeric indexes as strings.
 *
 * headerRowIndex is 0-based. If omitted, the first row matching all mandatory
 * column names is used.
 */
export function parseGeneric(
  buffer: Buffer,
  filename: string,
  mapping: GenericColumnMapping,
): ParseResult {
  const fileType = detectFileType(filename);
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  // Determine amount interpretation branch BEFORE processing rows
  const hasDebitCredit = !!(mapping.debitColumn && mapping.creditColumn);
  const hasAmountFlag = !!(mapping.amountColumn && mapping.drCrFlagColumn);
  const hasAmountOnly = !!(mapping.amountColumn && !mapping.drCrFlagColumn);

  if (!hasDebitCredit && !hasAmountFlag && !hasAmountOnly) {
    throw new BadRequestException(
      'Generic parser requires (debitColumn AND creditColumn) OR (amountColumn AND drCrFlagColumn) OR amountColumn alone',
    );
  }

  // Determine header row
  let headerRowIndex: number;
  if (mapping.headerRowIndex !== undefined) {
    headerRowIndex = mapping.headerRowIndex;
  } else {
    // Build list of mandatory column references for header detection
    const mandatoryRefs: string[] = [mapping.dateColumn, mapping.narrationColumn];
    if (hasDebitCredit) {
      mandatoryRefs.push(mapping.debitColumn!, mapping.creditColumn!);
    } else if (hasAmountFlag) {
      mandatoryRefs.push(mapping.amountColumn!, mapping.drCrFlagColumn!);
    } else {
      mandatoryRefs.push(mapping.amountColumn!);
    }
    headerRowIndex = autoDetectHeaderRow(rows, mandatoryRefs);
  }

  if (headerRowIndex === -1 || headerRowIndex >= rows.length) {
    return {
      rows: [],
      detectedFormat: 'generic',
      openingBalancePaise: null,
      closingBalancePaise: null,
      statementDateFrom: null,
      statementDateTo: null,
      warnings: ['Generic: header row not found — check column mapping'],
    };
  }

  // Build column index map from header row
  const headerCells = (rows[headerRowIndex] ?? []).map((c) =>
    String(c ?? '').trim(),
  );

  const dateIdx = resolveColumnIndex(mapping.dateColumn, headerCells);
  const narrationIdx = resolveColumnIndex(mapping.narrationColumn, headerCells);

  // Amount column indexes
  let debitIdx = -1;
  let creditIdx = -1;
  let amountIdx = -1;
  let drCrFlagIdx = -1;

  if (hasDebitCredit) {
    debitIdx = resolveColumnIndex(mapping.debitColumn!, headerCells);
    creditIdx = resolveColumnIndex(mapping.creditColumn!, headerCells);
  } else if (hasAmountFlag) {
    amountIdx = resolveColumnIndex(mapping.amountColumn!, headerCells);
    drCrFlagIdx = resolveColumnIndex(mapping.drCrFlagColumn!, headerCells);
  } else {
    // amountOnly
    amountIdx = resolveColumnIndex(mapping.amountColumn!, headerCells);
  }

  const refNumberIdx = mapping.refNumberColumn
    ? resolveColumnIndex(mapping.refNumberColumn, headerCells)
    : -1;
  const balanceIdx = mapping.balanceColumn
    ? resolveColumnIndex(mapping.balanceColumn, headerCells)
    : -1;
  const valueDateIdx = mapping.valueDateColumn
    ? resolveColumnIndex(mapping.valueDateColumn, headerCells)
    : -1;

  const warnings: string[] = [];
  const normalisedRows: NormalisedRow[] = [];
  let openingBalancePaise: number | null = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const get = (idx: number): string =>
      idx >= 0 ? String(row[idx] ?? '').trim() : '';

    const rawNarration = get(narrationIdx);

    // -----------------------------------------------------------------------
    // Branch 1: debitColumn AND creditColumn
    // -----------------------------------------------------------------------
    let debitPaise = 0;
    let creditPaise = 0;
    let amountPaise = 0;

    if (hasDebitCredit) {
      const rawDebit = get(debitIdx);
      const rawCredit = get(creditIdx);

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
      // amountPaise = creditPaise - debitPaise (signed, credit-positive convention)
      amountPaise = creditPaise - debitPaise;

    // -----------------------------------------------------------------------
    // Branch 2: amountColumn AND drCrFlagColumn
    // -----------------------------------------------------------------------
    } else if (hasAmountFlag) {
      const rawAmount = get(amountIdx);
      const rawFlag = get(drCrFlagIdx).toUpperCase();

      let amount = 0;
      try {
        amount = parsePaise(rawAmount || null);
      } catch {
        warnings.push(`Row ${i}: skipped — cannot parse amount: ${rawAmount}`);
        continue;
      }

      if (rawFlag.includes('DR')) {
        // DR = debit (money out, negative)
        debitPaise = amount;
        creditPaise = 0;
        amountPaise = -amount;
      } else if (rawFlag.includes('CR')) {
        // CR = credit (money in, positive)
        debitPaise = 0;
        creditPaise = amount;
        amountPaise = +amount;
      } else {
        warnings.push(
          `Row ${i}: skipped — DR/CR flag column value unrecognised: ${get(drCrFlagIdx)}`,
        );
        continue;
      }

    // -----------------------------------------------------------------------
    // Branch 3: amountColumn alone (signed amount)
    // -----------------------------------------------------------------------
    } else {
      const rawAmount = get(amountIdx);

      try {
        amountPaise = parsePaise(rawAmount || null);
      } catch {
        warnings.push(`Row ${i}: skipped — cannot parse amount: ${rawAmount}`);
        continue;
      }

      // positive = credit, negative = debit
      debitPaise = amountPaise < 0 ? -amountPaise : 0;
      creditPaise = amountPaise > 0 ? amountPaise : 0;
    }

    // Skip fully empty rows (no amount and empty narration)
    if (debitPaise === 0 && creditPaise === 0 && rawNarration === '') {
      continue;
    }

    // Parse transaction date
    let txnDate: Date;
    try {
      txnDate = parseDate(get(dateIdx) || null);
    } catch {
      warnings.push(`Row ${i}: skipped — cannot parse date: ${get(dateIdx)}`);
      continue;
    }

    // Parse value date (optional)
    let valueDate: Date | undefined;
    if (valueDateIdx >= 0) {
      const rawValueDate = get(valueDateIdx);
      if (rawValueDate) {
        try {
          valueDate = parseDate(rawValueDate);
        } catch {
          // value date is optional; skip without warning
        }
      }
    }

    // Parse closing balance (optional)
    let closingBalancePaise: number | undefined;
    if (balanceIdx >= 0) {
      const rawBalance = get(balanceIdx);
      if (rawBalance) {
        try {
          closingBalancePaise = parsePaise(rawBalance);
        } catch {
          // optional field
        }
      }
    }

    const narration = stripCsvFormulaPrefix(rawNarration);
    const refNumber: string | undefined =
      refNumberIdx >= 0 ? (get(refNumberIdx) || undefined) : undefined;

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
    detectedFormat: 'generic',
    openingBalancePaise,
    closingBalancePaise,
    statementDateFrom,
    statementDateTo,
    warnings,
  };
}
