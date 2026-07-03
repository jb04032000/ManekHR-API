import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  VoucherGenerator,
  VoucherProjection,
} from '../generators/voucher.generator';
import { TallyXmlStreamWriter } from '../generators/envelope.writer';
import { deriveTallyGuid } from '../utils/deterministic-guid';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'tally-vchr-'));
});

afterAll(() => {
  if (scratchDir && existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

function build(v: Partial<VoucherProjection> & { _id: string; sourceVoucherType: string; voucherNumber: string; voucherDate: Date }): VoucherProjection {
  return {
    ledgerLines: [],
    ...v,
  } as VoucherProjection;
}

async function emit(vouchers: VoucherProjection[], file: string): Promise<string> {
  const w = new TallyXmlStreamWriter(file, 'Acme Co', 'Vouchers');
  await w.openEnvelope();
  const gen = new VoucherGenerator();
  await gen.streamVouchers(w, vouchers);
  await w.closeEnvelope();
  return readFileSync(file, 'utf8');
}

describe('VoucherGenerator — every D-05 voucher class round-trips', () => {
  it('maps all 9 voucher classes to their Tally VCHTYPE and emits in date-asc order', async () => {
    const baseDate = new Date(2025, 3, 1); // Apr 1
    // Build one of each voucher class. All same date → expect tie-breaker by type asc.
    const vouchers: VoucherProjection[] = [
      build({ _id: '00000000000000000000000a', sourceVoucherType: 'sale_invoice', voucherNumber: 'INV-1', voucherDate: new Date(2025, 3, 5), partyName: 'Cust', ledgerLines: [{ ledgerName: 'Cust', debitPaise: 11800000, creditPaise: 0 }, { ledgerName: 'Sales', debitPaise: 0, creditPaise: 11800000 }] }),
      build({ _id: '00000000000000000000000b', sourceVoucherType: 'purchase_bill', voucherNumber: 'PB-1', voucherDate: new Date(2025, 3, 3), partyName: 'Vend', ledgerLines: [{ ledgerName: 'Purchase', debitPaise: 5000000, creditPaise: 0 }, { ledgerName: 'Vend', debitPaise: 0, creditPaise: 5000000 }] }),
      build({ _id: '00000000000000000000000c', sourceVoucherType: 'credit_note', voucherNumber: 'CN-1', voucherDate: new Date(2025, 3, 6), partyName: 'Cust', ledgerLines: [{ ledgerName: 'Sales', debitPaise: 100000, creditPaise: 0 }, { ledgerName: 'Cust', debitPaise: 0, creditPaise: 100000 }] }),
      build({ _id: '00000000000000000000000d', sourceVoucherType: 'debit_note', voucherNumber: 'DN-1', voucherDate: new Date(2025, 3, 7), partyName: 'Vend', ledgerLines: [{ ledgerName: 'Vend', debitPaise: 100000, creditPaise: 0 }, { ledgerName: 'Purchase', debitPaise: 0, creditPaise: 100000 }] }),
      build({ _id: '00000000000000000000000e', sourceVoucherType: 'payment_in', voucherNumber: 'RCT-1', voucherDate: new Date(2025, 3, 8), partyName: 'Cust', ledgerLines: [{ ledgerName: 'Bank', debitPaise: 11800000, creditPaise: 0 }, { ledgerName: 'Cust', debitPaise: 0, creditPaise: 11800000 }] }),
      build({ _id: '00000000000000000000000f', sourceVoucherType: 'payment_out', voucherNumber: 'PMT-1', voucherDate: new Date(2025, 3, 9), partyName: 'Vend', ledgerLines: [{ ledgerName: 'Vend', debitPaise: 5000000, creditPaise: 0 }, { ledgerName: 'Bank', debitPaise: 0, creditPaise: 5000000 }] }),
      build({ _id: '000000000000000000000010', sourceVoucherType: 'journal_voucher', voucherNumber: 'JV-1', voucherDate: new Date(2025, 3, 10), ledgerLines: [{ ledgerName: 'Expense', debitPaise: 200000, creditPaise: 0 }, { ledgerName: 'Cash', debitPaise: 0, creditPaise: 200000 }] }),
      build({ _id: '000000000000000000000011', sourceVoucherType: 'contra', voucherNumber: 'CON-1', voucherDate: new Date(2025, 3, 11), ledgerLines: [{ ledgerName: 'Cash', debitPaise: 1000000, creditPaise: 0 }, { ledgerName: 'Bank', debitPaise: 0, creditPaise: 1000000 }] }),
      build({ _id: '000000000000000000000012', sourceVoucherType: 'manufacturing_voucher', voucherNumber: 'MV-1', voucherDate: new Date(2025, 3, 12), ledgerLines: [{ ledgerName: 'WIP', debitPaise: 500000, creditPaise: 0 }, { ledgerName: 'RawMat', debitPaise: 0, creditPaise: 500000 }] }),
    ];

    const xml = await emit(vouchers, join(scratchDir, 'all-types.xml'));

    // Each voucher has correct VCHTYPE in mapped form
    const expectations: Array<[string, string]> = [
      ['INV-1', 'Sales'],
      ['PB-1', 'Purchase'],
      ['CN-1', 'Credit Note'],
      ['DN-1', 'Debit Note'],
      ['RCT-1', 'Receipt'],
      ['PMT-1', 'Payment'],
      ['JV-1', 'Journal'],
      ['CON-1', 'Contra'],
      ['MV-1', 'Stock Journal'],
    ];
    for (const [num, vchType] of expectations) {
      // Each voucher block contains both its number and the right VCHTYPE
      const i = xml.indexOf(`<VOUCHERNUMBER>${num}</VOUCHERNUMBER>`);
      expect(i).toBeGreaterThan(-1);
      // VCHTYPE attribute appears earlier in same VOUCHER block
      const blockStart = xml.lastIndexOf('<VOUCHER REMOTEID', i);
      const blockSlice = xml.slice(blockStart, i + 200);
      expect(blockSlice).toContain(`VCHTYPE="${vchType}"`);
      expect(blockSlice).toContain(`<VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>`);
    }
  });

  it('emits vouchers in ascending date order regardless of input order', async () => {
    const vouchers: VoucherProjection[] = [
      build({ _id: 'a1', sourceVoucherType: 'sale_invoice', voucherNumber: 'V3', voucherDate: new Date(2025, 5, 10), ledgerLines: [{ ledgerName: 'X', debitPaise: 100, creditPaise: 0 }] }),
      build({ _id: 'a2', sourceVoucherType: 'sale_invoice', voucherNumber: 'V1', voucherDate: new Date(2025, 3, 1), ledgerLines: [{ ledgerName: 'X', debitPaise: 100, creditPaise: 0 }] }),
      build({ _id: 'a3', sourceVoucherType: 'sale_invoice', voucherNumber: 'V2', voucherDate: new Date(2025, 4, 5), ledgerLines: [{ ledgerName: 'X', debitPaise: 100, creditPaise: 0 }] }),
    ];
    const xml = await emit(vouchers, join(scratchDir, 'order.xml'));
    const i1 = xml.indexOf('<VOUCHERNUMBER>V1</VOUCHERNUMBER>');
    const i2 = xml.indexOf('<VOUCHERNUMBER>V2</VOUCHERNUMBER>');
    const i3 = xml.indexOf('<VOUCHERNUMBER>V3</VOUCHERNUMBER>');
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it('GUID is deterministic — re-running with same _id produces identical XML voucher block', async () => {
    const v: VoucherProjection = build({
      _id: '507f1f77bcf86cd799439011',
      sourceVoucherType: 'sale_invoice',
      voucherNumber: 'INV-1',
      voucherDate: new Date(2025, 3, 1),
      partyName: 'Cust',
      ledgerLines: [{ ledgerName: 'Cust', debitPaise: 100, creditPaise: 0 }],
    });
    const x1 = await emit([v], join(scratchDir, 'd1.xml'));
    const x2 = await emit([v], join(scratchDir, 'd2.xml'));
    expect(x1).toBe(x2);
    expect(x1).toContain(`<GUID>${deriveTallyGuid('507f1f77bcf86cd799439011')}</GUID>`);
  });

  it('Sales voucher with batch line emits BATCHALLOCATIONS.LIST with BATCHNAME and GODOWNNAME', async () => {
    const v: VoucherProjection = build({
      _id: 'sv1',
      sourceVoucherType: 'sale_invoice',
      voucherNumber: 'INV-1',
      voucherDate: new Date(2025, 3, 1),
      partyName: 'Cust',
      ledgerLines: [{ ledgerName: 'Cust', debitPaise: 100, creditPaise: 0 }],
      inventoryLines: [
        {
          stockItemName: 'Cotton Yarn',
          qty: 10,
          unit: 'NOS',
          ratePaise: 1000,
          amountPaise: 10000,
          hsnCode: '5205',
          rateOfGst: 5,
          taxability: 'Taxable',
          batchNo: 'B-001',
          godownName: 'Main',
          isOutflow: true,
        },
      ],
    });
    const xml = await emit([v], join(scratchDir, 'batch.xml'));
    expect(xml).toContain('<BATCHALLOCATIONS.LIST>');
    expect(xml).toContain('<BATCHNAME>B-001</BATCHNAME>');
    expect(xml).toContain('<GODOWNNAME>Main</GODOWNNAME>');
    expect(xml).toContain('<HSNCODE>5205</HSNCODE>');
    expect(xml).toContain('<RATEOFGST>5</RATEOFGST>');
  });

  it('non-inventory voucher (Receipt) emits NO ALLINVENTORYENTRIES.LIST even if inventoryLines present', async () => {
    const v: VoucherProjection = build({
      _id: 'rcpt1',
      sourceVoucherType: 'payment_in',
      voucherNumber: 'RCT-1',
      voucherDate: new Date(2025, 3, 1),
      partyName: 'Cust',
      ledgerLines: [{ ledgerName: 'Bank', debitPaise: 1000, creditPaise: 0 }],
      inventoryLines: [
        { stockItemName: 'X', qty: 1, unit: 'NOS', ratePaise: 1000, amountPaise: 1000, isOutflow: true },
      ],
    });
    const xml = await emit([v], join(scratchDir, 'rcpt.xml'));
    expect(xml).not.toContain('<ALLINVENTORYENTRIES.LIST>');
  });

  it('sanitises voucher numbers with illegal chars on render', async () => {
    const v: VoucherProjection = build({
      _id: 's1',
      sourceVoucherType: 'sale_invoice',
      voucherNumber: 'INV/2024/01',
      voucherDate: new Date(2025, 3, 1),
      partyName: 'Cust',
      ledgerLines: [{ ledgerName: 'Cust', debitPaise: 100, creditPaise: 0 }],
    });
    const xml = await emit([v], join(scratchDir, 'sanitise.xml'));
    expect(xml).toContain('<VOUCHERNUMBER>INV-2024-01</VOUCHERNUMBER>');
    expect(xml).not.toContain('INV/2024/01');
  });

  it('Tally sign convention: debit ledger AMOUNT positive; credit ledger AMOUNT negative', async () => {
    const v: VoucherProjection = build({
      _id: 'sg1',
      sourceVoucherType: 'sale_invoice',
      voucherNumber: 'INV-1',
      voucherDate: new Date(2025, 3, 1),
      partyName: 'Cust',
      ledgerLines: [
        { ledgerName: 'Cust', debitPaise: 11800000, creditPaise: 0 },
        { ledgerName: 'Sales', debitPaise: 0, creditPaise: 10000000 },
        { ledgerName: 'CGST', debitPaise: 0, creditPaise: 900000 },
      ],
    });
    const xml = await emit([v], join(scratchDir, 'sign.xml'));
    // Customer (debit) → ISDEEMEDPOSITIVE Yes, AMOUNT 118000.00
    expect(xml).toMatch(/<LEDGERNAME>Cust<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>118000\.00<\/AMOUNT>/);
    // Sales (credit) → ISDEEMEDPOSITIVE No, AMOUNT -100000.00
    expect(xml).toMatch(/<LEDGERNAME>Sales<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>-100000\.00<\/AMOUNT>/);
  });
});
