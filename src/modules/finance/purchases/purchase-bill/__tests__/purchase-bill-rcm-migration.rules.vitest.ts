import { describe, it, expect } from 'vitest';
import { planRcmCorrection } from '../purchase-bill-rcm-migration.rules';

// Minimal LedgerLine shape for the planner (accountCode + debit/credit).
const line = (accountCode: string, debit: number, credit: number) => ({
  accountId: undefined as any,
  accountCode,
  accountName: accountCode,
  debit,
  credit,
});

// A pre-8bafb5c (WRONG) intra-state RCM bill entry: creditor over-credited the
// full grand total, NO output-payable credit. taxable 1000_00, cgst 90_00,
// sgst 90_00, tds 0 -> creditor credited 1180_00.
const wrongIntraEntry = [
  line('5001', 1000_00, 0), // Dr Purchases (taxable)
  line('1101', 90_00, 0), // Dr Input CGST
  line('1102', 90_00, 0), // Dr Input SGST
  line('2001', 0, 1180_00), // Cr Creditors (grand total — over-credited by tax)
];

describe('planRcmCorrection - migrate pre-8bafb5c RCM purchase-bill ledger entries', () => {
  it('returns not-applicable for a non-RCM bill', () => {
    const plan = planRcmCorrection(
      wrongIntraEntry,
      { isReverseCharge: false, cgstPaise: 90_00, sgstPaise: 90_00, igstPaise: 0 },
      true,
    );
    expect(plan.applicable).toBe(false);
    expect(plan.outputTaxLines).toEqual([]);
    expect(plan.creditorReductionPaise).toBe(0);
  });

  it('plans the intra-state correction: Cr CGST+SGST output payable, reduce creditor by total tax', () => {
    const plan = planRcmCorrection(
      wrongIntraEntry,
      { isReverseCharge: true, cgstPaise: 90_00, sgstPaise: 90_00, igstPaise: 0 },
      true,
    );
    expect(plan.applicable).toBe(true);
    expect(plan.alreadyMigrated).toBe(false);
    expect(plan.outputTaxLines).toEqual([
      { accountCode: '2007', paise: 90_00 },
      { accountCode: '2008', paise: 90_00 },
    ]);
    expect(plan.creditorReductionPaise).toBe(180_00); // total RCM tax
  });

  it('plans the inter-state correction: Cr IGST output payable only', () => {
    const wrongInter = [
      line('5001', 1000_00, 0),
      line('1100', 180_00, 0), // Dr Input IGST
      line('2001', 0, 1180_00),
    ];
    const plan = planRcmCorrection(
      wrongInter,
      { isReverseCharge: true, cgstPaise: 0, sgstPaise: 0, igstPaise: 180_00 },
      false,
    );
    expect(plan.outputTaxLines).toEqual([{ accountCode: '2006', paise: 180_00 }]);
    expect(plan.creditorReductionPaise).toBe(180_00);
  });

  it('is idempotent: an entry already carrying an output-payable credit is alreadyMigrated', () => {
    const correctedEntry = [
      ...wrongIntraEntry.filter((l) => l.accountCode !== '2001'),
      line('2007', 0, 90_00), // already has output CGST payable
      line('2008', 0, 90_00),
      line('2001', 0, 1000_00), // creditor already reduced to taxable
    ];
    const plan = planRcmCorrection(
      correctedEntry,
      { isReverseCharge: true, cgstPaise: 90_00, sgstPaise: 90_00, igstPaise: 0 },
      true,
    );
    expect(plan.applicable).toBe(true);
    expect(plan.alreadyMigrated).toBe(true);
    expect(plan.outputTaxLines).toEqual([]);
    expect(plan.creditorReductionPaise).toBe(0);
  });

  it('creditor reduction always equals the sum of the output-tax lines (keeps the entry balanced)', () => {
    const plan = planRcmCorrection(
      wrongIntraEntry,
      { isReverseCharge: true, cgstPaise: 90_00, sgstPaise: 90_00, igstPaise: 0 },
      true,
    );
    const sumOut = plan.outputTaxLines.reduce((s, l) => s + l.paise, 0);
    expect(plan.creditorReductionPaise).toBe(sumOut);
  });
});
