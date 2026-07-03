import { describe, it, expect } from 'vitest';
import {
  PreExportValidator,
  ValidatorIssue,
} from '../validators/pre-export-validator.service';

const v = new PreExportValidator();

describe('PreExportValidator (D-09 — never blocks; emits structured warnings)', () => {
  it('emits LEDGER_NAME_TOO_LONG when account name > 30 chars (with truncation suggestion)', () => {
    const longName = 'A'.repeat(35); // 35 chars
    const report = v.validate({
      accounts: [
        { _id: 'a1', name: longName, hasTransactionsInRange: true, hasOpeningBalance: true },
      ],
      parties: [],
      vouchers: [],
    });
    expect(report.blockers).toEqual([]);
    const issue = report.warnings.find((w) => w.code === 'LEDGER_NAME_TOO_LONG');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('WARNING');
    expect(issue!.refType).toBe('ledger');
    expect(issue!.refId).toBe('a1');
    expect((issue!.meta as any).truncated).toBe('A'.repeat(30));
    expect((issue!.meta as any).maxLength).toBe(30);
  });

  it('does not emit LEDGER_NAME_TOO_LONG when name is exactly 30 chars', () => {
    const report = v.validate({
      accounts: [{ _id: 'a1', name: 'A'.repeat(30) }],
      parties: [],
      vouchers: [],
    });
    expect(report.warnings.filter((w) => w.code === 'LEDGER_NAME_TOO_LONG')).toEqual([]);
  });

  it('emits VOUCHER_ILLEGAL_CHAR for forbidden characters and provides sanitised replacement', () => {
    const report = v.validate({
      accounts: [],
      parties: [],
      vouchers: [{ _id: 'v1', voucherNumber: 'INV/2024/01', voucherType: 'sale_invoice' }],
    });
    const issue = report.warnings.find((w) => w.code === 'VOUCHER_ILLEGAL_CHAR')!;
    expect(issue).toBeDefined();
    expect(issue.refType).toBe('voucher');
    expect((issue.meta as any).sanitized).toBe('INV-2024-01');
  });

  it.each([
    ['INV\\2024\\01', 'INV-2024-01'],
    ['INV:2024:01', 'INV-2024-01'],
    ['INV?A', 'INV-A'],
    ['INV*A', 'INV-A'],
    ['INV|A', 'INV-A'],
    ['INV"A', 'INV-A'],
  ])('VOUCHER_ILLEGAL_CHAR catches "%s" → "%s"', (input, expected) => {
    const r = v.validate({
      accounts: [],
      parties: [],
      vouchers: [{ _id: 'v', voucherNumber: input, voucherType: 'sale_invoice' }],
    });
    const issue = r.warnings.find((w) => w.code === 'VOUCHER_ILLEGAL_CHAR')!;
    expect(issue).toBeDefined();
    expect((issue.meta as any).sanitized).toBe(expected);
  });

  it('does NOT emit VOUCHER_ILLEGAL_CHAR for clean voucher numbers', () => {
    const r = v.validate({
      accounts: [],
      parties: [],
      vouchers: [
        { _id: 'v', voucherNumber: 'INV-2024-01', voucherType: 'sale_invoice' },
        { _id: 'v2', voucherNumber: 'CN_2024_001', voucherType: 'credit_note' },
      ],
    });
    expect(r.warnings.filter((w) => w.code === 'VOUCHER_ILLEGAL_CHAR')).toEqual([]);
  });

  it('emits PARTY_HSN_NO_GSTIN when a party has HSN sales but no GSTIN', () => {
    const r = v.validate({
      accounts: [],
      parties: [{ _id: 'p1', name: 'Cash Customer', hasHsnSales: true, gstin: undefined }],
      vouchers: [],
    });
    const issue = r.warnings.find((w) => w.code === 'PARTY_HSN_NO_GSTIN');
    expect(issue).toBeDefined();
    expect(issue!.refType).toBe('party');
    expect(issue!.refId).toBe('p1');
  });

  it('does NOT emit PARTY_HSN_NO_GSTIN when GSTIN is present', () => {
    const r = v.validate({
      accounts: [],
      parties: [{ _id: 'p1', name: 'Acme', hasHsnSales: true, gstin: '24ABCDE1234F1Z5' }],
      vouchers: [],
    });
    expect(r.warnings.filter((w) => w.code === 'PARTY_HSN_NO_GSTIN')).toEqual([]);
  });

  it('emits MISSING_OPENING_BALANCE when account has txns but no opening balance', () => {
    const r = v.validate({
      accounts: [{ _id: 'a1', name: 'Bank', hasTransactionsInRange: true, hasOpeningBalance: false }],
      parties: [],
      vouchers: [],
    });
    expect(r.warnings.find((w) => w.code === 'MISSING_OPENING_BALANCE')).toBeDefined();
  });

  it('does NOT emit MISSING_OPENING_BALANCE when opening balance is present', () => {
    const r = v.validate({
      accounts: [{ _id: 'a1', name: 'Bank', hasTransactionsInRange: true, hasOpeningBalance: true }],
      parties: [],
      vouchers: [],
    });
    expect(r.warnings.filter((w) => w.code === 'MISSING_OPENING_BALANCE')).toEqual([]);
  });

  it('blockers array is always empty (D-09 — validator NEVER blocks)', () => {
    const r = v.validate({
      accounts: [
        { _id: 'a1', name: 'A'.repeat(50), hasTransactionsInRange: true, hasOpeningBalance: false },
      ],
      parties: [{ _id: 'p1', name: 'X'.repeat(40), hasHsnSales: true }],
      vouchers: [{ _id: 'v1', voucherNumber: '/?*\\', voucherType: 'sale_invoice' }],
    });
    expect(r.blockers).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const w of r.warnings as ValidatorIssue[]) {
      expect(w.severity).toBe('WARNING');
    }
  });

  it('static helpers expose sanitisation primitives used by the voucher generator', () => {
    expect(PreExportValidator.sanitiseVoucherNumber('INV/2024/01')).toBe('INV-2024-01');
    expect(PreExportValidator.truncateLedgerName('A'.repeat(50))).toBe('A'.repeat(30));
    expect(PreExportValidator.truncateLedgerName('Short')).toBe('Short');
  });
});
