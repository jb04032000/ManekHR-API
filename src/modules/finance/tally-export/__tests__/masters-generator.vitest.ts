import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MastersGenerator } from '../generators/masters.generator';
import { TallyXmlStreamWriter } from '../generators/envelope.writer';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'tally-masters-'));
});

afterAll(() => {
  if (scratchDir && existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

describe('MastersGenerator — D-03 ordering + tax-ledger seeding', () => {
  it('emits masters in mandatory order: GROUP → LEDGER (tax) → LEDGER (account) → LEDGER (party) → UNIT → STOCKITEM', async () => {
    const out = join(scratchDir, 'order.xml');
    const w = new TallyXmlStreamWriter(out, 'Acme Co', 'All Masters');
    await w.openEnvelope();
    const gen = new MastersGenerator();
    await gen.streamMasters(w, {
      accounts: [
        // Custom group: a sub-group not in Tally primaries
        { _id: 'a1', name: 'Bank of Baroda', type: 'asset', subGroup: 'Bank Accounts' },
        { _id: 'a2', name: 'Local Reserves', type: 'capital', subGroup: 'My Custom Reserve' },
      ],
      parties: [
        { _id: 'p1', name: 'Acme Traders', partyType: 'customer', gstin: '24ABCDE1234F1Z5' },
        { _id: 'p2', name: 'Cement Vendor Ltd', partyType: 'vendor' },
      ],
      stockItems: [
        { _id: 's1', name: 'Cotton Yarn', unit: 'NOS', hsnSacCode: '5205', gstRate: 5 },
        { _id: 's2', name: 'Polyester Yarn', unit: 'KG', hsnSacCode: '5402', gstRate: 12 },
      ],
    });
    await w.closeEnvelope();

    const xml = readFileSync(out, 'utf8');

    // Custom group emitted before any LEDGER
    const idxGroup = xml.indexOf('<GROUP NAME="My Custom Reserve"');
    expect(idxGroup).toBeGreaterThan(-1);

    const idxCgst = xml.indexOf('<LEDGER NAME="CGST"');
    const idxAccount = xml.indexOf('<LEDGER NAME="Bank of Baroda"');
    const idxParty = xml.indexOf('<LEDGER NAME="Acme Traders"');
    const idxUnit = xml.indexOf('<UNIT NAME="NOS"');
    const idxStock = xml.indexOf('<STOCKITEM NAME="Cotton Yarn"');

    // All present
    expect(idxCgst).toBeGreaterThan(-1);
    expect(idxAccount).toBeGreaterThan(-1);
    expect(idxParty).toBeGreaterThan(-1);
    expect(idxUnit).toBeGreaterThan(-1);
    expect(idxStock).toBeGreaterThan(-1);

    // Strict ordering: GROUP before LEDGER, tax before account, account before party,
    // party before UNIT, UNIT before STOCKITEM.
    expect(idxGroup).toBeLessThan(idxCgst);
    expect(idxCgst).toBeLessThan(idxAccount);
    expect(idxAccount).toBeLessThan(idxParty);
    expect(idxParty).toBeLessThan(idxUnit);
    expect(idxUnit).toBeLessThan(idxStock);
  });

  it('emits exactly 4 tax ledgers (CGST/SGST/IGST/CESS) with TAXTYPE+DUTYHEAD', async () => {
    const out = join(scratchDir, 'tax.xml');
    const w = new TallyXmlStreamWriter(out, 'X', 'All Masters');
    await w.openEnvelope();
    const gen = new MastersGenerator();
    await gen.streamMasters(w, { accounts: [], parties: [], stockItems: [] });
    await w.closeEnvelope();
    const xml = readFileSync(out, 'utf8');

    for (const name of ['CGST', 'SGST', 'IGST', 'CESS']) {
      expect(xml).toContain(`<LEDGER NAME="${name}" ACTION="Create">`);
      expect(xml).toContain(`<DUTYHEAD>${name}</DUTYHEAD>`);
    }
    expect(xml).toContain('<TAXTYPE>GST</TAXTYPE>');
  });

  it('routes party type to the correct primary group (customer→Sundry Debtors, vendor→Sundry Creditors)', async () => {
    const out = join(scratchDir, 'party.xml');
    const w = new TallyXmlStreamWriter(out, 'X', 'All Masters');
    await w.openEnvelope();
    const gen = new MastersGenerator();
    await gen.streamMasters(w, {
      accounts: [],
      parties: [
        { _id: 'c', name: 'CustomerOne', partyType: 'customer' },
        { _id: 'v', name: 'VendorOne', partyType: 'vendor' },
      ],
      stockItems: [],
    });
    await w.closeEnvelope();
    const xml = readFileSync(out, 'utf8');
    // Find LEDGER blocks and verify PARENT group
    const customerSlice = xml.slice(xml.indexOf('CustomerOne'));
    expect(customerSlice).toContain('<PARENT>Sundry Debtors</PARENT>');
    const vendorSlice = xml.slice(xml.indexOf('VendorOne'));
    expect(vendorSlice).toContain('<PARENT>Sundry Creditors</PARENT>');
  });

  it('truncates ledger names exceeding 30 chars to keep Tally happy', async () => {
    const out = join(scratchDir, 'trunc.xml');
    const w = new TallyXmlStreamWriter(out, 'X', 'All Masters');
    await w.openEnvelope();
    const gen = new MastersGenerator();
    await gen.streamMasters(w, {
      accounts: [],
      parties: [{ _id: 'p1', name: 'A'.repeat(40), partyType: 'customer' }],
      stockItems: [],
    });
    await w.closeEnvelope();
    const xml = readFileSync(out, 'utf8');
    // Truncated to 30 chars
    expect(xml).toContain(`<LEDGER NAME="${'A'.repeat(30)}" ACTION="Create">`);
    expect(xml).not.toContain(`<LEDGER NAME="${'A'.repeat(40)}"`);
  });
});
