/**
 * One-time migration rules for reverse-charge (RCM) purchase bills posted
 * BEFORE commit 8bafb5c (which added the missing Cr Output GST Payable + fixed
 * the creditor over-credit for NEW bills).
 *
 * A pre-8bafb5c RCM bill's ledger entry is WRONG in two linked ways:
 *   1. it has NO Cr 2006/2007/2008 Output GST Payable line (the self-assessed
 *      RCM liability that feeds GSTR-3B 3.1(d)); and
 *   2. its Cr 2001 Creditors line was credited the grand total (taxable + tax)
 *      instead of just the taxable value (under RCM the tax is paid to the
 *      government, not the supplier).
 *
 * The fix amends the bill's existing `purchase_bill` entry: ADD the output-tax
 * credit lines and REDUCE the creditor credit by the same total tax. Net credits
 * are unchanged, so the entry stays balanced and ends up identical to a
 * correctly-posted (post-8bafb5c) RCM bill. Pure so the money rules are
 * unit-tested without the migration's DB plumbing.
 */
import {
  rcmOutputTaxLines,
  RCM_OUTPUT_CODE,
  type RcmOutputTaxLine,
} from './purchase-bill-rcm.rules';

interface MinLedgerLine {
  accountCode: string;
  debit: number;
  credit: number;
}

interface RcmBillTax {
  isReverseCharge?: boolean;
  cgstPaise?: number;
  sgstPaise?: number;
  igstPaise?: number;
}

export interface RcmCorrectionPlan {
  /** True when the bill is reverse-charge (otherwise nothing to do). */
  applicable: boolean;
  /** True when the entry already carries an output-payable credit (posted
   *  post-8bafb5c, or already migrated) — skip to stay idempotent. */
  alreadyMigrated: boolean;
  /** Amount to subtract from the Cr 2001 Creditors line (= total RCM tax). */
  creditorReductionPaise: number;
  /** Output GST Payable credit lines to ADD (2006 igst / 2007 cgst / 2008 sgst). */
  outputTaxLines: RcmOutputTaxLine[];
}

const OUTPUT_CODES = new Set<string>([
  RCM_OUTPUT_CODE.igst,
  RCM_OUTPUT_CODE.cgst,
  RCM_OUTPUT_CODE.sgst,
]);

/**
 * Plan the correcting amendment for one bill's existing ledger entry.
 * `isIntraState` selects CGST+SGST vs IGST; for an already-posted bill it is
 * recoverable from the bill's own tax split (igstPaise > 0 -> inter-state).
 */
export function planRcmCorrection(
  entryLines: MinLedgerLine[],
  bill: RcmBillTax,
  isIntraState: boolean,
): RcmCorrectionPlan {
  if (!bill.isReverseCharge) {
    return {
      applicable: false,
      alreadyMigrated: false,
      creditorReductionPaise: 0,
      outputTaxLines: [],
    };
  }

  const alreadyMigrated = entryLines.some((l) => OUTPUT_CODES.has(l.accountCode) && l.credit > 0);
  if (alreadyMigrated) {
    return {
      applicable: true,
      alreadyMigrated: true,
      creditorReductionPaise: 0,
      outputTaxLines: [],
    };
  }

  const outputTaxLines = rcmOutputTaxLines(bill, isIntraState);
  const creditorReductionPaise = outputTaxLines.reduce((sum, l) => sum + l.paise, 0);
  return { applicable: true, alreadyMigrated: false, creditorReductionPaise, outputTaxLines };
}

/**
 * Derive intra-vs-inter-state from a posted bill's own tax split: any IGST means
 * inter-state. (At original post time this came from comparing firm vs party
 * state codes; the recorded tax split is the durable witness of that decision.)
 */
export function isIntraStateFromTax(bill: RcmBillTax): boolean {
  return (bill.igstPaise ?? 0) === 0;
}
