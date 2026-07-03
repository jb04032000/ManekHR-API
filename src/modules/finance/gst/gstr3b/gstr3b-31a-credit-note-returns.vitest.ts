/**
 * R1 regression — GSTR-3B Table 3.1(a) must net the period's credit notes by
 * their TAXABLE VALUE, not just their tax.
 *
 * Background: credit notes route their revenue reversal to the Sales Returns
 * contra-revenue account 4009 (ledger-posting.service.ts #14), falling back to
 * Sales 4001 only for firms whose CoA predates the 4009 seed. The 3.1(a)
 * credit-note adjustment aggregation must therefore match BOTH 4001 and 4009 on
 * the debit side and map both to `txval`. A regression that matched only 4001
 * left `3.1.a.txval` overstated for every firm with 4009 seeded (the tax cells
 * still netted via 2006/2007/2008, masking the bug on the tax side).
 *
 * Lives next to the SUT (not under __tests__/) so Vitest uses its default
 * esbuild transform — mirrors gstr3b-export-table5.vitest.ts. @nestjs/mongoose
 * is stubbed so the transitively-imported schemas load without `design:type`
 * metadata; this test drives computeAuto() against mocked model.aggregate
 * implementations and never touches a DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => {
  const chainableProxy: any = new Proxy({}, { get: () => () => chainableProxy });
  return {
    Prop: () => () => {},
    Schema: () => (target: any) => target,
    SchemaFactory: { createForClass: () => chainableProxy },
    InjectModel: () => () => {},
    raw: (v: any) => v,
    MongooseModule: { forFeature: () => ({}), forRoot: () => ({}) },
  };
});

import { Gstr3bService } from './gstr3b.service';

const WS = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FIRM = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// Gross outward for the period: taxable 100000 paise, intra-state 9% + 9%.
const OUTWARD_TAX = [
  { _id: '2007', total: 9000 }, // CGST payable
  { _id: '2008', total: 9000 }, // SGST payable
];
const OUTWARD_TXVAL = [{ txval: 100000 }];

// One credit note in the period: taxable 20000 reversed, 1800 + 1800 tax reversed.
// `returnsCode` is the account the CN debits for its taxable value (4009 modern
// seed, 4001 legacy fallback).
function creditNoteDebits(returnsCode: string) {
  return [
    { _id: returnsCode, total: 20000 },
    { _id: '2007', total: 1800 },
    { _id: '2008', total: 1800 },
  ];
}

function buildService(returnsCode: string): Gstr3bService {
  const ledgerEntryModel = {
    aggregate: vi.fn((pipeline: any[]) => {
      const entryType = pipeline?.[0]?.$match?.entryType;
      if (entryType === 'sale_invoice') return Promise.resolve(OUTWARD_TAX);
      if (entryType === 'credit_note') return Promise.resolve(creditNoteDebits(returnsCode));
      return Promise.resolve([]);
    }),
  };
  const saleInvoiceModel = {
    aggregate: vi.fn((pipeline: any[]) => {
      const m = pipeline?.[0]?.$match ?? {};
      // The 3.1(a) taxable-value query is the only sale-invoice aggregation that
      // filters exportType with $nin and has no $or / placeOfSupply grouping.
      const isOutwardTxval = m.exportType?.$nin && !m.$or && !m.placeOfSupplyStateCode;
      return Promise.resolve(isOutwardTxval ? OUTWARD_TXVAL : []);
    }),
  };
  const purchaseBillModel = { aggregate: vi.fn(() => Promise.resolve([])) };
  const firmModel = {
    findOne: vi.fn(() => ({
      lean: () => Promise.resolve({ gstin: '24AAAAA0000A1Z5', stateCode: '24' }),
    })),
  };
  return new (Gstr3bService as any)(
    ledgerEntryModel,
    saleInvoiceModel,
    purchaseBillModel,
    firmModel,
    null, // adjustmentModel — unused by computeAuto
    null, // postHog — unused by computeAuto
  );
}

describe('Gstr3bService.computeAuto — 3.1(a) credit-note netting (R1 regression)', () => {
  let service: Gstr3bService;

  describe('credit note debits Sales Returns 4009 (modern CoA)', () => {
    beforeEach(() => {
      service = buildService('4009');
    });

    it('nets the credit-note taxable value out of 3.1(a) txval', async () => {
      const report = await service.computeAuto(WS, FIRM, '042026');
      // 100000 gross - 20000 CN = 80000. The pre-fix code matched only 4001 on
      // the debit side, so txval stayed at 100000 here.
      expect(report.sec_3_1_a.txval).toBe(80000);
    });

    it('still nets the tax cells (regression guard, was already correct)', async () => {
      const report = await service.computeAuto(WS, FIRM, '042026');
      expect(report.sec_3_1_a.cgst).toBe(7200); // 9000 - 1800
      expect(report.sec_3_1_a.sgst).toBe(7200);
      expect(report.sec_3_1_a.igst).toBe(0);
    });
  });

  describe('credit note debits Sales 4001 (legacy CoA fallback)', () => {
    beforeEach(() => {
      service = buildService('4001');
    });

    it('still nets the credit-note taxable value out of 3.1(a) txval', async () => {
      const report = await service.computeAuto(WS, FIRM, '042026');
      expect(report.sec_3_1_a.txval).toBe(80000);
    });
  });
});
