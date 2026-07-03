import { describe, it, expect } from 'vitest';
import { mapVoucherType, voucherTypeCarriesInventory } from '../mappings/voucher-type-mapping';
import { mapAccountToTallyGroup } from '../mappings/coa-mapping';
import { TAX_LEDGERS } from '../mappings/gst-tax-ledger.constants';
import { escapeXml } from '../utils/escape-xml';
import { paiseToTallyAmount } from '../utils/paise-to-tally-amount';
import { dateYyyymmdd } from '../utils/date-yyyymmdd';

describe('escapeXml', () => {
  it('escapes the five XML predefined entities', () => {
    expect(escapeXml('A & B<x>"y"\'z\'')).toBe('A &amp; B&lt;x&gt;&quot;y&quot;&apos;z&apos;');
  });
  it('returns empty string for null/undefined/empty input', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
    expect(escapeXml('')).toBe('');
  });
});

describe('paiseToTallyAmount', () => {
  it.each([
    [12345678, '123456.78'],
    [-100, '-1.00'],
    [0, '0.00'],
    [50, '0.50'],
    [9, '0.09'],
    [-9, '-0.09'],
    [100000000, '1000000.00'],
  ])('paise %i → "%s"', (paise, expected) => {
    expect(paiseToTallyAmount(paise)).toBe(expected);
  });
});

describe('dateYyyymmdd', () => {
  it('formats Date as YYYYMMDD', () => {
    expect(dateYyyymmdd(new Date(2025, 3, 1))).toBe('20250401'); // April = month 3
    expect(dateYyyymmdd(new Date(2025, 11, 31))).toBe('20251231');
    expect(dateYyyymmdd(new Date(2024, 0, 5))).toBe('20240105');
  });
});

describe('mapVoucherType (D-05 — every internal voucher class)', () => {
  const cases: Array<[string, string]> = [
    ['sale_invoice', 'Sales'],
    ['tax_invoice', 'Sales'],
    ['bill_of_supply', 'Sales'],
    ['export_invoice', 'Sales'],
    ['sales_return', 'Credit Note'],
    ['credit_note', 'Credit Note'],
    ['purchase_bill', 'Purchase'],
    ['purchase_return', 'Debit Note'],
    ['debit_note', 'Debit Note'],
    ['payment_in', 'Receipt'],
    ['receipt', 'Receipt'],
    ['payment_out', 'Payment'],
    ['journal_voucher', 'Journal'],
    ['contra', 'Contra'],
    ['manufacturing_voucher', 'Stock Journal'],
    ['job_work_out', 'Stock Journal'],
    ['job_work_in', 'Stock Journal'],
  ];
  it.each(cases)('%s → %s', (internal, tally) => {
    expect(mapVoucherType(internal)).toBe(tally);
  });

  it('falls back to Journal for unknown voucher types', () => {
    expect(mapVoucherType('something_unknown')).toBe('Journal');
    expect(mapVoucherType('')).toBe('Journal');
  });

  it('voucherTypeCarriesInventory only true for Sales/Purchase/CN/DN/SJ', () => {
    expect(voucherTypeCarriesInventory('sale_invoice')).toBe(true);
    expect(voucherTypeCarriesInventory('purchase_bill')).toBe(true);
    expect(voucherTypeCarriesInventory('credit_note')).toBe(true);
    expect(voucherTypeCarriesInventory('debit_note')).toBe(true);
    expect(voucherTypeCarriesInventory('manufacturing_voucher')).toBe(true);
    expect(voucherTypeCarriesInventory('payment_in')).toBe(false);
    expect(voucherTypeCarriesInventory('journal_voucher')).toBe(false);
    expect(voucherTypeCarriesInventory('contra')).toBe(false);
  });
});

describe('mapAccountToTallyGroup (D-04 — COA mapping)', () => {
  it('matches direct sub-group names against Tally primaries', () => {
    expect(mapAccountToTallyGroup({ type: 'asset', subGroup: 'Sundry Debtors' })).toBe('Sundry Debtors');
    expect(mapAccountToTallyGroup({ type: 'liability', subGroup: 'Sundry Creditors' })).toBe('Sundry Creditors');
    expect(mapAccountToTallyGroup({ type: 'asset', subGroup: 'Bank Accounts' })).toBe('Bank Accounts');
    expect(mapAccountToTallyGroup({ type: 'asset', subGroup: 'Cash-in-Hand' })).toBe('Cash-in-Hand');
    expect(mapAccountToTallyGroup({ type: 'asset', subGroup: 'cash in hand' })).toBe('Cash-in-Hand');
    expect(mapAccountToTallyGroup({ type: 'asset', subGroup: 'Stock-in-Hand' })).toBe('Stock-in-Hand');
    expect(mapAccountToTallyGroup({ type: 'asset', subGroup: 'Fixed Assets' })).toBe('Fixed Assets');
    expect(mapAccountToTallyGroup({ type: 'liability', subGroup: 'Duties & Taxes' })).toBe('Duties & Taxes');
    expect(mapAccountToTallyGroup({ type: 'liability', subGroup: 'Duties and Taxes' })).toBe('Duties & Taxes');
    expect(mapAccountToTallyGroup({ type: 'capital', subGroup: 'Capital Account' })).toBe('Capital Account');
    expect(mapAccountToTallyGroup({ type: 'capital', subGroup: 'Reserves & Surplus' })).toBe('Reserves & Surplus');
    expect(mapAccountToTallyGroup({ type: 'capital', subGroup: 'Retained Earnings' })).toBe('Reserves & Surplus');
  });

  it('falls back to type-based default when subGroup is unknown/empty', () => {
    expect(mapAccountToTallyGroup({ type: 'asset' })).toBe('Current Assets');
    expect(mapAccountToTallyGroup({ type: 'liability' })).toBe('Current Liabilities');
    expect(mapAccountToTallyGroup({ type: 'capital' })).toBe('Capital Account');
    expect(mapAccountToTallyGroup({ type: 'income', subGroup: '' })).toBe('Sales Accounts');
    expect(mapAccountToTallyGroup({ type: 'expense' })).toBe('Indirect Expenses');
    expect(mapAccountToTallyGroup({ type: 'unknown_type' as any })).toBe('Suspense A/c');
  });

  it('uses group field as fallback when subGroup is missing', () => {
    expect(mapAccountToTallyGroup({ type: 'asset', group: 'Sundry Debtors' })).toBe('Sundry Debtors');
  });
});

describe('TAX_LEDGERS constant (D-07)', () => {
  it('contains exactly CGST/SGST/IGST/CESS', () => {
    expect(TAX_LEDGERS.map((t) => t.dutyHead)).toEqual(['CGST', 'SGST', 'IGST', 'CESS']);
  });
  it('all entries are TaxType=GST under "Duties & Taxes"', () => {
    for (const t of TAX_LEDGERS) {
      expect(t.taxType).toBe('GST');
      expect(t.parentGroup).toBe('Duties & Taxes');
    }
  });
});
