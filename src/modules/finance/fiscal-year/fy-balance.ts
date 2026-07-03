import { PreconditionFailedException } from '@nestjs/common';

/**
 * X3 / BK-6: a fiscal year must NOT be closed while its ledger is out of
 * balance. In double-entry every voucher posts equal debits and credits, so a
 * complete, correct ledger always has total debits == total credits. If they
 * differ, some posting is broken and closing would carry the wrong figure into
 * next year's opening balances. This gate is HARD (non-skippable, unlike the
 * advisory pre-close health checks) and throws with the exact imbalance.
 *
 * Pure function (takes the per-account aggregation rows) so it is unit-tested in
 * isolation without standing up the FY-close transaction + its dependencies.
 */
export function assertLedgerBalanced(
  rows: ReadonlyArray<{ debit?: number | null; credit?: number | null }>,
): void {
  const debitPaise = rows.reduce((sum, r) => sum + (r.debit ?? 0), 0);
  const creditPaise = rows.reduce((sum, r) => sum + (r.credit ?? 0), 0);
  if (debitPaise !== creditPaise) {
    const rupees = (p: number) => `Rs ${(p / 100).toFixed(2)}`;
    throw new PreconditionFailedException({
      message:
        `Cannot close: the ledger is out of balance for this financial year ` +
        `(debits ${rupees(debitPaise)} vs credits ${rupees(creditPaise)}, ` +
        `difference ${rupees(Math.abs(debitPaise - creditPaise))}). ` +
        `Every voucher must post equal debits and credits; review the day book / trial balance before closing.`,
      debitPaise,
      creditPaise,
      differencePaise: debitPaise - creditPaise,
    });
  }
}
