import { describe, it, expect } from 'vitest';
import { parseGstr2b, reconcileGstr2b, normInvNo, type BillRow } from '../gstr2b-recon';

describe('parseGstr2b', () => {
  it('parses docdata.b2b with nested inv[] and converts rupees to paise', () => {
    const json = {
      docdata: {
        b2b: [
          {
            ctin: '24AAACR4521K1Z9',
            inv: [
              {
                invno: 'INV-1',
                idt: '2026-05-01',
                txval: 1000,
                iamt: 0,
                camt: 90,
                samt: 90,
                itcavl: 'Y',
              },
            ],
          },
        ],
      },
    };
    const rows = parseGstr2b(json);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gstin: '24AAACR4521K1Z9',
      invNo: 'INV-1',
      taxablePaise: 100000,
      cgstPaise: 9000,
      sgstPaise: 9000,
      igstPaise: 0,
      itcAvailable: true,
      source: 'b2b',
    });
  });

  it('handles flat (non-nested) supplier rows + itcavl=N + imports section', () => {
    const rows = parseGstr2b({
      docdata: {
        b2b: [
          {
            ctin: '27AAAAA0000A1Z5',
            invno: 'A/2',
            idt: '2026-05-02',
            txval: 500,
            iamt: 90,
            itcavl: 'N',
          },
        ],
        imp: [{ ctin: 'IMPORT', invno: 'BOE-9', idt: '2026-05-03', txval: 200, iamt: 36 }],
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      invNo: 'A/2',
      igstPaise: 9000,
      itcAvailable: false,
      source: 'b2b',
    });
    expect(rows[1]).toMatchObject({ invNo: 'BOE-9', igstPaise: 3600, source: 'imp' });
  });

  it('returns [] for empty/garbage input', () => {
    expect(parseGstr2b(null)).toEqual([]);
    expect(parseGstr2b({})).toEqual([]);
    expect(parseGstr2b({ docdata: {} })).toEqual([]);
  });
});

describe('normInvNo', () => {
  it('uppercases + strips non-alphanumerics so "inv-1 " == "INV/1"', () => {
    expect(normInvNo('inv-1 ')).toBe('INV1');
    expect(normInvNo('INV/1')).toBe('INV1');
  });
});

describe('reconcileGstr2b', () => {
  const bill = (over: Partial<BillRow> = {}): BillRow => ({
    billId: 'b1',
    gstin: '24AAACR4521K1Z9',
    vendorBillNumber: 'INV-1',
    vendorBillDate: '2026-05-01',
    taxablePaise: 100000,
    igstPaise: 0,
    cgstPaise: 9000,
    sgstPaise: 9000,
    ...over,
  });
  const row2b = (over = {}) => ({
    gstin: '24AAACR4521K1Z9',
    invNo: 'INV-1',
    invDate: '2026-05-01',
    taxablePaise: 100000,
    igstPaise: 0,
    cgstPaise: 9000,
    sgstPaise: 9000,
    itcAvailable: true,
    source: 'b2b' as const,
    ...over,
  });

  it('matches on GSTIN + normalized invoice no even with formatting differences', () => {
    const res = reconcileGstr2b([row2b({ invNo: 'inv/1' })], [bill({ vendorBillNumber: 'INV-1' })]);
    expect(res.summary.matched).toBe(1);
    expect(res.rows[0].status).toBe('matched');
    expect(res.rows[0].score).toBe(100);
  });

  it('flags PARTIAL when key matches but tax amount drifts beyond tolerance', () => {
    const res = reconcileGstr2b([row2b({ cgstPaise: 9500, sgstPaise: 9500 })], [bill()]);
    expect(res.summary.partial).toBe(1);
    expect(res.rows[0].status).toBe('partial');
    expect(res.rows[0].deltas?.taxPaise).toBe(1000); // 19000 (2B) - 18000 (books)
    expect(res.summary.itcAtRiskPaise).toBe(1000);
  });

  it('tolerates sub-Rs1 rounding noise as matched', () => {
    const res = reconcileGstr2b([row2b({ taxablePaise: 100050 })], [bill()]);
    expect(res.rows[0].status).toBe('matched'); // 50p <= 100p tol
  });

  it('missing_in_books: 2B row with no bill; itcAtRisk = its full tax', () => {
    const res = reconcileGstr2b([row2b({ invNo: 'GHOST-9' })], [bill()]);
    expect(res.summary.missingInBooks).toBe(1);
    expect(res.summary.missingIn2b).toBe(1); // the bill is now unreported
    const ghost = res.rows.find((r) => r.status === 'missing_in_books');
    expect(ghost?.twoB?.invNo).toBe('GHOST-9');
    expect(res.summary.itcAtRiskPaise).toBe(18000); // full tax of the ghost row
  });

  it('missing_in_2b: bill recorded, supplier did not report it', () => {
    const res = reconcileGstr2b([], [bill()]);
    expect(res.summary.missingIn2b).toBe(1);
    expect(res.rows[0].status).toBe('missing_in_2b');
    expect(res.rows[0].bill?.billId).toBe('b1');
  });
});
