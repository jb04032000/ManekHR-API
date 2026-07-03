/**
 * PreExportValidator (D-09) — runs server-side and returns a structured report
 * of warnings the user can inspect before clicking "Export anyway".
 *
 * NEVER blocks the export. The `BLOCKER` severity is reserved for future use;
 * all current rules emit `WARNING` only.
 *
 * Rules (per RESEARCH "Field-length and validator rules"):
 *   - LEDGER_NAME_TOO_LONG     — Account/Party name > 30 chars
 *   - VOUCHER_ILLEGAL_CHAR     — voucherNumber contains / \ : ? * | "
 *   - PARTY_HSN_NO_GSTIN       — party has HSN-coded sales but no GSTIN
 *   - MISSING_OPENING_BALANCE  — ledger has txns in range but no opening balance
 */
import { Injectable } from '@nestjs/common';

export type ValidatorSeverity = 'BLOCKER' | 'WARNING';
export type ValidatorRefType = 'ledger' | 'party' | 'voucher' | 'item';

export interface ValidatorIssue {
  severity: ValidatorSeverity;
  code: string;
  message: string;
  refType: ValidatorRefType;
  refId: string;
  refName: string;
  /** Optional metadata, e.g. truncation suggestion. */
  meta?: Record<string, unknown>;
}

export interface ValidatorReport {
  blockers: ValidatorIssue[];
  warnings: ValidatorIssue[];
}

const ILLEGAL_CHAR_RE = /[\\/:?*|"]/;
const LEDGER_NAME_MAX = 30;

export interface ValidatorInputAccount {
  _id: string;
  name: string;
  hasTransactionsInRange?: boolean;
  hasOpeningBalance?: boolean;
}
export interface ValidatorInputParty {
  _id: string;
  name: string;
  gstin?: string;
  hasHsnSales?: boolean;
}
export interface ValidatorInputVoucher {
  _id: string;
  voucherNumber: string;
  voucherType: string;
}

@Injectable()
export class PreExportValidator {
  /**
   * Pure-function validation core — accepts already-loaded data and returns
   * the validator report. The Mongo-aggregation that loads this data lives
   * in the orchestrator (TallyExportService); separating the two keeps this
   * service unit-testable without mongo-memory.
   */
  validate(input: {
    accounts: ValidatorInputAccount[];
    parties: ValidatorInputParty[];
    vouchers: ValidatorInputVoucher[];
  }): ValidatorReport {
    const warnings: ValidatorIssue[] = [];
    const blockers: ValidatorIssue[] = []; // reserved — never populated today

    // RULE: LEDGER_NAME_TOO_LONG
    for (const a of input.accounts) {
      if (a.name && a.name.length > LEDGER_NAME_MAX) {
        const truncated = a.name.slice(0, LEDGER_NAME_MAX);
        warnings.push({
          severity: 'WARNING',
          code: 'LEDGER_NAME_TOO_LONG',
          message: `Ledger "${a.name}" exceeds Tally's ${LEDGER_NAME_MAX}-char limit; will be truncated to "${truncated}".`,
          refType: 'ledger',
          refId: a._id,
          refName: a.name,
          meta: { maxLength: LEDGER_NAME_MAX, truncated },
        });
      }
    }
    for (const p of input.parties) {
      if (p.name && p.name.length > LEDGER_NAME_MAX) {
        const truncated = p.name.slice(0, LEDGER_NAME_MAX);
        warnings.push({
          severity: 'WARNING',
          code: 'LEDGER_NAME_TOO_LONG',
          message: `Party ledger "${p.name}" exceeds Tally's ${LEDGER_NAME_MAX}-char limit; will be truncated to "${truncated}".`,
          refType: 'party',
          refId: p._id,
          refName: p.name,
          meta: { maxLength: LEDGER_NAME_MAX, truncated },
        });
      }
    }

    // RULE: VOUCHER_ILLEGAL_CHAR
    for (const v of input.vouchers) {
      if (v.voucherNumber && ILLEGAL_CHAR_RE.test(v.voucherNumber)) {
        const sanitized = v.voucherNumber.replace(/[\\/:?*|"]/g, '-');
        warnings.push({
          severity: 'WARNING',
          code: 'VOUCHER_ILLEGAL_CHAR',
          message: `Voucher "${v.voucherNumber}" contains characters Tally rejects (/ \\ : ? * | "); will be replaced with "-" → "${sanitized}".`,
          refType: 'voucher',
          refId: v._id,
          refName: v.voucherNumber,
          meta: { sanitized },
        });
      }
    }

    // RULE: PARTY_HSN_NO_GSTIN
    for (const p of input.parties) {
      if (p.hasHsnSales && !p.gstin) {
        warnings.push({
          severity: 'WARNING',
          code: 'PARTY_HSN_NO_GSTIN',
          message: `Party "${p.name}" has HSN-coded sales but no GSTIN — Tally will import as unregistered.`,
          refType: 'party',
          refId: p._id,
          refName: p.name,
        });
      }
    }

    // RULE: MISSING_OPENING_BALANCE
    for (const a of input.accounts) {
      if (a.hasTransactionsInRange && a.hasOpeningBalance === false) {
        warnings.push({
          severity: 'WARNING',
          code: 'MISSING_OPENING_BALANCE',
          message: `Ledger "${a.name}" has transactions in the export range but no opening balance — Tally trial balance may not tally on first import.`,
          refType: 'ledger',
          refId: a._id,
          refName: a.name,
        });
      }
    }

    return { blockers, warnings };
  }

  /**
   * Sanitises a voucher number against Tally's rejected-char list. Same
   * regex as the validator emits, exported so the voucher generator can
   * apply identical sanitisation when writing `<VOUCHERNUMBER>`.
   */
  static sanitiseVoucherNumber(num: string): string {
    return (num || '').replace(/[\\/:?*|"]/g, '-');
  }

  /**
   * Truncates a ledger name to Tally's max length deterministically.
   */
  static truncateLedgerName(name: string): string {
    return (name || '').slice(0, LEDGER_NAME_MAX);
  }
}
