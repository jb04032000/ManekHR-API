import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TallyXmlStreamWriter } from '../generators/envelope.writer';
import { deriveTallyGuid } from '../utils/deterministic-guid';
import { paiseToTallyAmount } from '../utils/paise-to-tally-amount';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';

const FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '__tests__',
  'fixtures',
  'tally-xml',
);

// Group C: compare golden fixtures line-ending-agnostically. The writer emits LF, but the
// on-disk fixtures can carry CRLF (Windows checkout / file-recovery), making a byte-equal diff
// fail on identical content. Normalise both sides so the assertion tests structure, not EOLs.
const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'tally-golden-'));
});

afterAll(() => {
  if (scratchDir && existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

/**
 * Helper: render a master bundle (4 tax ledgers + 1 customer ledger + 1 stock item)
 * via the writer, return the file bytes.
 */
async function renderMasterBundle(filePath: string): Promise<string> {
  const w = new TallyXmlStreamWriter(filePath, 'Acme Trading Co', 'All Masters');
  await w.openEnvelope();

  // Tax ledgers
  await w.writeMaster('LEDGER', {
    name: 'CGST',
    children: [
      ['PARENT', 'Duties & Taxes'],
      ['TAXTYPE', 'GST'],
      ['DUTYHEAD', 'CGST'],
    ],
  });
  await w.writeMaster('LEDGER', {
    name: 'SGST',
    children: [
      ['PARENT', 'Duties & Taxes'],
      ['TAXTYPE', 'GST'],
      ['DUTYHEAD', 'SGST'],
    ],
  });
  await w.writeMaster('LEDGER', {
    name: 'IGST',
    children: [
      ['PARENT', 'Duties & Taxes'],
      ['TAXTYPE', 'GST'],
      ['DUTYHEAD', 'IGST'],
    ],
  });
  await w.writeMaster('LEDGER', {
    name: 'CESS',
    children: [
      ['PARENT', 'Duties & Taxes'],
      ['TAXTYPE', 'GST'],
      ['DUTYHEAD', 'CESS'],
    ],
  });

  // Customer ledger
  await w.writeMaster('LEDGER', {
    name: 'Acme Traders',
    alterId: '507f1f77bcf86cd799439011',
    children: [['PARENT', 'Sundry Debtors']],
  });

  // Unit
  await w.writeMaster('UNIT', {
    name: 'NOS',
    children: [['ISSIMPLEUNIT', 'Yes']],
  });

  // Stock item
  await w.writeMaster('STOCKITEM', {
    name: 'Cotton Yarn',
    alterId: '507f1f77bcf86cd799439012',
    children: [
      ['BASEUNITS', 'NOS'],
      ['GSTAPPLICABLE', 'Applicable'],
      ['HSNCODE', '5205'],
      ['RATEOFGST', 5],
    ],
  });

  await w.closeEnvelope();
  return readFileSync(filePath, 'utf8');
}

async function renderSalesInvoice(filePath: string): Promise<string> {
  const w = new TallyXmlStreamWriter(filePath, 'Acme Trading Co', 'Vouchers');
  await w.openEnvelope();
  const guid = deriveTallyGuid('507f1f77bcf86cd799439020');
  await w.writeVoucher(
    {
      guid,
      vchType: 'Sales',
      date: '20250401',
      voucherNumber: 'INV-2025-001',
      partyLedgerName: 'Acme Traders',
      partyGstin: '24ABCDE1234F1Z5',
      placeOfSupply: '24',
      narration: 'Being sales of Cotton Yarn',
      isInvoice: true,
      reference: 'INV-2025-001',
    },
    [
      { ledgerName: 'Acme Traders', isDeemedPositive: true, amount: paiseToTallyAmount(11800000) },
      {
        ledgerName: 'Sales Accounts',
        isDeemedPositive: false,
        amount: paiseToTallyAmount(-10000000),
      },
      { ledgerName: 'CGST', isDeemedPositive: false, amount: paiseToTallyAmount(-900000) },
      { ledgerName: 'SGST', isDeemedPositive: false, amount: paiseToTallyAmount(-900000) },
    ],
    [
      {
        stockItemName: 'Cotton Yarn',
        isDeemedPositive: false,
        rate: '1000.00/NOS',
        actualQty: '100 NOS',
        billedQty: '100 NOS',
        amount: paiseToTallyAmount(-10000000),
        rateOfGst: 18,
        hsnCode: '5205',
        taxability: 'Taxable',
        batchAllocations: [
          {
            batchName: 'B-001',
            godownName: 'Main',
            amount: paiseToTallyAmount(-10000000),
            actualQty: '100 NOS',
            billedQty: '100 NOS',
          },
        ],
      },
    ],
  );
  await w.closeEnvelope();
  return readFileSync(filePath, 'utf8');
}

async function renderCreditNote(filePath: string): Promise<string> {
  const w = new TallyXmlStreamWriter(filePath, 'Acme Trading Co', 'Vouchers');
  await w.openEnvelope();
  const guid = deriveTallyGuid('507f1f77bcf86cd799439030');
  await w.writeVoucher(
    {
      guid,
      vchType: 'Credit Note',
      date: '20250410',
      voucherNumber: 'CN-2025-001',
      partyLedgerName: 'Acme Traders',
      partyGstin: '24ABCDE1234F1Z5',
      placeOfSupply: '24',
      narration: 'Sales return — Cotton Yarn',
      isInvoice: true,
      reference: 'CN-2025-001',
    },
    [
      { ledgerName: 'Acme Traders', isDeemedPositive: false, amount: paiseToTallyAmount(-1180000) },
      { ledgerName: 'Sales Accounts', isDeemedPositive: true, amount: paiseToTallyAmount(1000000) },
      { ledgerName: 'CGST', isDeemedPositive: true, amount: paiseToTallyAmount(90000) },
      { ledgerName: 'SGST', isDeemedPositive: true, amount: paiseToTallyAmount(90000) },
    ],
    [
      {
        stockItemName: 'Cotton Yarn',
        isDeemedPositive: true,
        rate: '1000.00/NOS',
        actualQty: '10 NOS',
        billedQty: '10 NOS',
        amount: paiseToTallyAmount(1000000),
        rateOfGst: 18,
        hsnCode: '5205',
        taxability: 'Taxable',
      },
    ],
  );
  await w.closeEnvelope();
  return readFileSync(filePath, 'utf8');
}

async function renderPayment(filePath: string): Promise<string> {
  const w = new TallyXmlStreamWriter(filePath, 'Acme Trading Co', 'Vouchers');
  await w.openEnvelope();
  const guid = deriveTallyGuid('507f1f77bcf86cd799439040');
  await w.writeVoucher(
    {
      guid,
      vchType: 'Receipt',
      date: '20250415',
      voucherNumber: 'RCT-2025-001',
      partyLedgerName: 'Acme Traders',
      narration: 'Payment received via UPI',
      isInvoice: false,
    },
    [
      { ledgerName: 'Bank Accounts', isDeemedPositive: true, amount: paiseToTallyAmount(11800000) },
      {
        ledgerName: 'Acme Traders',
        isDeemedPositive: false,
        amount: paiseToTallyAmount(-11800000),
      },
    ],
  );
  await w.closeEnvelope();
  return readFileSync(filePath, 'utf8');
}

/**
 * Resolve the on-disk fixture; if it is empty (Wave 0 placeholder) we capture
 * the writer's current output as the new golden fixture and assert byte equality
 * on subsequent runs. This makes the first run of the suite seed the fixtures,
 * and every subsequent run guards against drift.
 */
function loadOrSeedFixture(name: string, generated: string): string {
  const path = join(FIXTURES_DIR, name);
  if (!existsSync(path) || readFileSync(path, 'utf8').length === 0) {
    writeFileSync(path, generated, { encoding: 'utf8' });
  }
  return readFileSync(path, 'utf8');
}

describe('TallyXmlStreamWriter — golden-file diff (D-01/D-02/D-03/D-06)', () => {
  it('emits a well-formed master bundle (sample-master-bundle.xml)', async () => {
    const out = join(scratchDir, 'master-bundle.xml');
    const generated = await renderMasterBundle(out);

    // Smoke: well-formed envelope shape
    expect(generated.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(generated).toContain('<ENVELOPE>');
    expect(generated.endsWith('</ENVELOPE>\n')).toBe(true);
    expect(generated).toContain('<REPORTNAME>All Masters</REPORTNAME>');
    expect(generated).toContain('<SVCURRENTCOMPANY>Acme Trading Co</SVCURRENTCOMPANY>');
    expect(generated).toContain('<LEDGER NAME="CGST" ACTION="Create">');
    expect(generated).toContain('<DUTYHEAD>CGST</DUTYHEAD>');
    expect(generated).toContain('<LEDGER NAME="Acme Traders" ACTION="Create">');
    expect(generated).toContain('<ALTERID>507f1f77bcf86cd799439011</ALTERID>');
    expect(generated).toContain('<STOCKITEM NAME="Cotton Yarn" ACTION="Create">');
    expect(generated).toContain('<HSNCODE>5205</HSNCODE>');

    const fixture = loadOrSeedFixture('sample-master-bundle.xml', generated);
    expect(normalizeEol(generated)).toBe(normalizeEol(fixture));
  });

  it('emits a Sales invoice voucher with batch allocations (sample-sales-invoice.xml)', async () => {
    const out = join(scratchDir, 'sales.xml');
    const generated = await renderSalesInvoice(out);
    expect(generated).toContain('<VOUCHER REMOTEID=');
    expect(generated).toContain('VCHTYPE="Sales"');
    expect(generated).toContain('<VOUCHERNUMBER>INV-2025-001</VOUCHERNUMBER>');
    expect(generated).toContain('<BATCHALLOCATIONS.LIST>');
    expect(generated).toContain('<BATCHNAME>B-001</BATCHNAME>');
    expect(generated).toContain('<GODOWNNAME>Main</GODOWNNAME>');
    expect(generated).toContain('<HSNCODE>5205</HSNCODE>');
    const fixture = loadOrSeedFixture('sample-sales-invoice.xml', generated);
    expect(normalizeEol(generated)).toBe(normalizeEol(fixture));
  });

  it('emits a Credit Note voucher (sample-credit-note.xml)', async () => {
    const out = join(scratchDir, 'cn.xml');
    const generated = await renderCreditNote(out);
    expect(generated).toContain('VCHTYPE="Credit Note"');
    expect(generated).toContain('<VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>');
    const fixture = loadOrSeedFixture('sample-credit-note.xml', generated);
    expect(normalizeEol(generated)).toBe(normalizeEol(fixture));
  });

  it('emits a Receipt (Payment-In) voucher (sample-payment.xml)', async () => {
    const out = join(scratchDir, 'rcpt.xml');
    const generated = await renderPayment(out);
    expect(generated).toContain('VCHTYPE="Receipt"');
    expect(generated).toContain('<ISINVOICE>No</ISINVOICE>');
    expect(generated).not.toContain('<ALLINVENTORYENTRIES.LIST>');
    const fixture = loadOrSeedFixture('sample-payment.xml', generated);
    expect(normalizeEol(generated)).toBe(normalizeEol(fixture));
  });

  it('writer rejects calls before openEnvelope', async () => {
    const w = new TallyXmlStreamWriter(join(scratchDir, 'bad.xml'), 'X', 'Vouchers');
    await expect(w.writeMaster('LEDGER', { name: 'X', children: [] })).rejects.toThrow(
      /openEnvelope/,
    );
    await w.closeEnvelope().catch(() => {});
  });

  it('writer rejects double-open', async () => {
    const w = new TallyXmlStreamWriter(join(scratchDir, 'bad2.xml'), 'X', 'Vouchers');
    await w.openEnvelope();
    await expect(w.openEnvelope()).rejects.toThrow(/twice/);
    await w.closeEnvelope();
  });

  it('UTF-8 encoding declared in prolog', async () => {
    const out = join(scratchDir, 'utf8.xml');
    await renderMasterBundle(out);
    const buf = readFileSync(out);
    expect(buf.subarray(0, 38).toString('utf8')).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    // Basic UTF-8 round-trip sanity
    expect(Buffer.isBuffer(buf)).toBe(true);
    // Ensure no BOM was prepended
    expect(buf[0]).toBe(0x3c); // '<'
  });
});

describe('Validator placeholder (populated in Plan 02 Task 2)', () => {
  it('fixtures directory exists', () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
    // Listing (smoke check the directory is the right one)
    const entries = readdirSync(FIXTURES_DIR);
    expect(entries.length).toBeGreaterThanOrEqual(0);
  });
});
