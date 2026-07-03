/**
 * NormalisedRow — the common shape produced by all bank parsers.
 * Wave 3 BankStatementParserService consumes ParseResult to create BankStatementRow documents.
 */
export interface NormalisedRow {
  /** 0-based row index from the source file (after header row). */
  rowIndex: number;
  /** Transaction date — UTC midnight to avoid timezone skew (Pitfall 8). */
  txnDate: Date;
  /** Value date if present in statement. */
  valueDate?: Date;
  /** Raw narration after CSV-injection sanitisation (stripCsvFormulaPrefix applied). */
  narration: string;
  /** Cheque number, UTR, NEFT ref, or equivalent. */
  refNumber?: string;
  /** Amount debited in paise (0 if credit row). Integer, never float. */
  debitPaise: number;
  /** Amount credited in paise (0 if debit row). Integer, never float. */
  creditPaise: number;
  /**
   * Signed amount in paise: credit positive, debit negative.
   * Derived: creditPaise - debitPaise.
   */
  amountPaise: number;
  /** Running closing balance in paise, if present in statement. */
  closingBalancePaise?: number;
}

/**
 * ParseResult — full output of a bank parser call.
 * Includes the NormalisedRow array plus statement-level metadata.
 */
export interface ParseResult {
  rows: NormalisedRow[];
  /** Canonical bank key that was detected. */
  detectedFormat: string;
  /** Opening balance in paise from the statement, or null if not available. */
  openingBalancePaise: number | null;
  /** Closing balance in paise from the last row's closing balance, or null. */
  closingBalancePaise: number | null;
  /** Earliest txnDate across all rows, or null for empty statement. */
  statementDateFrom: Date | null;
  /** Latest txnDate across all rows, or null for empty statement. */
  statementDateTo: Date | null;
  /** Non-fatal warnings collected during parsing (skipped rows, etc.). */
  warnings: string[];
}

/**
 * Canonical bank format keys.
 * Wave 2 covers hdfc, icici, sbi, axis.
 * Wave 3 (Plan 03) will add kotak, yes_bank, indusind, pnb, bob.
 * 'generic' is the fallback for unknown formats.
 */
export type BankFormatKey =
  | 'hdfc'
  | 'icici'
  | 'sbi'
  | 'axis'
  | 'kotak'
  | 'yes_bank'
  | 'indusind'
  | 'pnb'
  | 'bob'
  | 'generic';
