import { describe, it, expect } from 'vitest';
import { PreconditionFailedException } from '@nestjs/common';
import { assertLedgerBalanced } from '../fy-balance';

// X3 / BK-6: the FY-close balance gate.
describe('assertLedgerBalanced (FY-close Dr=Cr gate)', () => {
  it('passes when total debits equal total credits', () => {
    expect(() =>
      assertLedgerBalanced([
        { debit: 10000, credit: 0 },
        { debit: 0, credit: 4000 },
        { debit: 0, credit: 6000 },
      ]),
    ).not.toThrow();
  });

  it('throws PreconditionFailed when debits != credits', () => {
    expect(() =>
      assertLedgerBalanced([
        { debit: 10000, credit: 0 },
        { debit: 0, credit: 9999 },
      ]),
    ).toThrow(PreconditionFailedException);
  });

  it('reports the exact imbalance in the thrown payload', () => {
    try {
      assertLedgerBalanced([
        { debit: 10000, credit: 0 },
        { debit: 0, credit: 9000 },
      ]);
      throw new Error('expected to throw');
    } catch (e) {
      const res = (e as PreconditionFailedException).getResponse() as Record<string, unknown>;
      expect(res.debitPaise).toBe(10000);
      expect(res.creditPaise).toBe(9000);
      expect(res.differencePaise).toBe(1000);
    }
  });

  it('treats null/undefined debit/credit as 0', () => {
    expect(() => assertLedgerBalanced([{ debit: 500 }, { credit: 500 }])).not.toThrow();
  });

  it('passes on an empty ledger (0 == 0)', () => {
    expect(() => assertLedgerBalanced([])).not.toThrow();
  });
});
