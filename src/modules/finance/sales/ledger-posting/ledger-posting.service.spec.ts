import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { InternalServerErrorException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LedgerPostingService, PostSaleInvoiceOptions, PostPaymentInOptions } from './ledger-posting.service';
import { LedgerEntry } from './ledger-entry.schema';
import { AccountsService } from '../../ledger/accounts.service';
import { TaxComputationResult } from '../tax-computation/tax-computation.service';

// ─── Mock helpers ────────────────────────────────────────────────────────────

const mockAccountId = (code: string) => new Types.ObjectId();

/**
 * Returns an AccountsService mock that resolves each code to a unique ObjectId.
 */
function makeMockAccountsService() {
  const codeToId: Record<string, Types.ObjectId> = {};
  const findByCode = jest.fn(async (_wsId: string, _firmId: string, code: string) => {
    if (!codeToId[code]) codeToId[code] = new Types.ObjectId();
    return { _id: codeToId[code], name: `Account ${code}`, code } as any;
  });
  return { findByCode };
}

/**
 * Returns a Mongoose model mock.
 * new model(data) returns an object with a save() spy returning { ...data, _id: new ObjectId() }.
 */
function makeMockModel() {
  const mockSave = jest.fn().mockImplementation(function (this: any) {
    return Promise.resolve({ ...this, _id: new Types.ObjectId() });
  });

  // Constructor-style mock: `new this.model(data)` returns obj with save()
  const ModelMock = jest.fn().mockImplementation(function (data: any) {
    Object.assign(this, data);
    this.save = mockSave;
    this._id = new Types.ObjectId();
  }) as any;

  ModelMock.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  ModelMock.mockSave = mockSave;

  return ModelMock;
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const firmId = new Types.ObjectId();
const workspaceId = new Types.ObjectId();
const partyId = new Types.ObjectId();
const invoiceId = new Types.ObjectId();
const userId = new Types.ObjectId().toString();

const baseOpts: Omit<PostSaleInvoiceOptions, 'isIntraState'> = {
  userId,
  session: undefined,
  firm: { _id: firmId, workspaceId, gstin: '24AAAPZ4321K2Z1' },
  party: { _id: partyId, name: 'Test Party' },
  invoice: {
    _id: invoiceId,
    voucherNumber: 'INV/25-26/0001',
    voucherType: 'sale_invoice',
    invoiceDate: new Date('2025-04-01'),
    financialYear: '2025-26',
  },
};

/** Minimal TaxComputationResult for intra-state 18% */
function makeIntraTaxResult(overrides: Partial<TaxComputationResult> = {}): TaxComputationResult {
  return {
    lines: [],
    subtotalPaise: 10000,
    totalDiscountPaise: 0,
    taxableValuePaise: 10000,
    additionalChargesPaise: 0,
    cgstPaise: 900,
    sgstPaise: 900,
    igstPaise: 0,
    cessPaise: 0,
    tcsPaise: 0,
    roundOffPaise: 0,
    grandTotalPaise: 11800,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LedgerPostingService', () => {
  let service: LedgerPostingService;
  let mockModel: ReturnType<typeof makeMockModel>;
  let mockAccountsSvc: ReturnType<typeof makeMockAccountsService>;

  beforeEach(async () => {
    mockModel = makeMockModel();
    mockAccountsSvc = makeMockAccountsService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerPostingService,
        { provide: AccountsService, useValue: mockAccountsSvc },
        { provide: getModelToken(LedgerEntry.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get<LedgerPostingService>(LedgerPostingService);
  });

  it('test_invariant_intra: 4 balanced lines for intra-state invoice', async () => {
    const taxResult = makeIntraTaxResult();
    let capturedLines: any[] = [];

    mockModel.mockImplementation(function (data: any) {
      Object.assign(this, data);
      capturedLines = data.lines;
      this._id = new Types.ObjectId();
      this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
    });

    await service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: true });

    // Dr 1003 grandTotal=11800, Cr 4001=10000, Cr 2007=900, Cr 2008=900
    expect(capturedLines).toHaveLength(4);

    const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(11800);

    const drLine = capturedLines.find((l: any) => l.debit > 0);
    expect(drLine?.accountCode).toBe('1003');
    expect(drLine?.debit).toBe(11800);
  });

  it('test_invariant_inter: 3 balanced lines for inter-state invoice (IGST)', async () => {
    // igst=1800, cgst=0, sgst=0
    const taxResult = makeIntraTaxResult({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1800 });
    let capturedLines: any[] = [];

    mockModel.mockImplementation(function (data: any) {
      Object.assign(this, data);
      capturedLines = data.lines;
      this._id = new Types.ObjectId();
      this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
    });

    await service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: false });

    // Dr 1003=11800, Cr 4001=10000, Cr 2006=1800
    expect(capturedLines).toHaveLength(3);

    const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);

    const igstLine = capturedLines.find((l: any) => l.accountCode === '2006');
    expect(igstLine?.credit).toBe(1800);
  });

  it('test_invariant_with_tcs: 5 balanced lines when TCS is applied', async () => {
    // grandTotal = 11800 + 590 = 12390
    const taxResult = makeIntraTaxResult({ tcsPaise: 590, grandTotalPaise: 12390 });
    let capturedLines: any[] = [];

    mockModel.mockImplementation(function (data: any) {
      Object.assign(this, data);
      capturedLines = data.lines;
      this._id = new Types.ObjectId();
      this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
    });

    await service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: true });

    // Dr 1003=12390, Cr 4001=10000, Cr 2007=900, Cr 2008=900, Cr 2004=590
    expect(capturedLines).toHaveLength(5);

    const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(12390);

    const tcsLine = capturedLines.find((l: any) => l.accountCode === '2004');
    expect(tcsLine?.credit).toBe(590);
  });

  it('test_invariant_with_roundoff_positive: Cr 4005 when grandTotal > rawTotal', async () => {
    // rawTotal=11797 rounded up to 11800 → roundOff=+3 → Cr 4005
    // grandTotal=11800; taxable=10000; cgst=900; sgst=900; roundOff=+3
    // sum credits = 10000+900+900+3 = 11803 — but grand=11800, so debit=11800
    // Hmm — when roundOff is positive, grandTotal = rawTotal + roundOff.
    // rawTotal = taxable + cgst + sgst = 11800, roundOff = +3 means rounded to 11803? No.
    // Per D-18.6: roundedTotal = round(rawTotal/100)*100; roundOff = roundedTotal - rawTotal.
    // rawTotal=11797 → rounded=11800 → roundOff=+3 → grand=11800.
    // credits: 4001=10000 + 2007=900 + 2008=897 (adjusted for the math) ...
    // Actually let's just use explicit values that balance:
    // grand=11800; taxable=10000; cgst=900; sgst=897; roundOff=+3
    // Dr 1003=11800; Cr 4001=10000 + Cr 2007=900 + Cr 2008=897 + Cr 4005=3 = 11800 ✓
    const taxResult = makeIntraTaxResult({
      taxableValuePaise: 10000,
      cgstPaise: 900,
      sgstPaise: 897,
      roundOffPaise: 3,
      grandTotalPaise: 11800,
    });
    let capturedLines: any[] = [];

    mockModel.mockImplementation(function (data: any) {
      Object.assign(this, data);
      capturedLines = data.lines;
      this._id = new Types.ObjectId();
      this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
    });

    await service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: true });

    const roundOffLine = capturedLines.find((l: any) => l.accountCode === '4005');
    expect(roundOffLine).toBeDefined();
    expect(roundOffLine.credit).toBe(3);

    const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('test_invariant_with_roundoff_negative: Dr 5010 when grandTotal < rawTotal', async () => {
    // rawTotal=11803 → rounded=11800 → roundOff=-3 → grand=11800
    // Dr 1003=11800; Dr 5010=3; Cr 4001=10000 + Cr 2007=900 + Cr 2008=903 = 11803
    const taxResult = makeIntraTaxResult({
      taxableValuePaise: 10000,
      cgstPaise: 900,
      sgstPaise: 903,
      roundOffPaise: -3,
      grandTotalPaise: 11800,
    });
    let capturedLines: any[] = [];

    mockModel.mockImplementation(function (data: any) {
      Object.assign(this, data);
      capturedLines = data.lines;
      this._id = new Types.ObjectId();
      this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
    });

    await service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: true });

    const roundOffLine = capturedLines.find((l: any) => l.accountCode === '5010');
    expect(roundOffLine).toBeDefined();
    expect(roundOffLine.debit).toBe(3);

    const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
    const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('test_throws_on_imbalance: throws InternalServerErrorException when debit ≠ credit', async () => {
    // Feed a taxResult where grandTotalPaise ≠ sum(taxable+cgst+sgst)
    // grandTotal=9999 but credits would sum to 11800 → imbalance
    const taxResult = makeIntraTaxResult({
      grandTotalPaise: 9999,  // deliberately wrong — debit won't match credits
    });

    await expect(
      service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: true }),
    ).rejects.toThrow(InternalServerErrorException);

    await expect(
      service.postSaleInvoice(taxResult, { ...baseOpts, isIntraState: true }),
    ).rejects.toThrow(/Ledger imbalance/);
  });

  // ─── postPaymentIn tests ──────────────────────────────────────────────────

  describe('postPaymentIn', () => {
    const paymentOpts: PostPaymentInOptions = {
      userId,
      session: undefined,
      firm: { _id: firmId, workspaceId, gstin: '24AAAPZ4321K2Z1' },
    };

    function makeReceipt(overrides: Partial<{
      paymentMode: string;
      totalAmountPaise: number;
      allocations: Array<{ allocatedPaise: number }>;
      unappliedPaise: number;
    }> = {}) {
      return {
        _id: new Types.ObjectId(),
        workspaceId,
        firmId,
        financialYear: '2025-26',
        receiptDate: new Date('2025-04-01'),
        partyId,
        partySnapshot: { name: 'Test Party' },
        paymentMode: 'cash',
        totalAmountPaise: 50000,
        allocations: [{ allocatedPaise: 50000 }],
        unappliedPaise: 0,
        voucherNumber: 'REC/25-26/0001',
        ...overrides,
      };
    }

    it('creates Dr Cash Cr Debtors entry for cash payment with no unapplied', async () => {
      const receipt = makeReceipt({ paymentMode: 'cash', totalAmountPaise: 50000, allocations: [{ allocatedPaise: 50000 }], unappliedPaise: 0 });
      let capturedLines: any[] = [];

      mockModel.mockImplementation(function (data: any) {
        Object.assign(this, data);
        capturedLines = data.lines;
        this._id = new Types.ObjectId();
        this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
      });

      await service.postPaymentIn(receipt, paymentOpts);

      expect(capturedLines).toHaveLength(2);
      const drLine = capturedLines.find((l: any) => l.debit > 0);
      expect(drLine?.accountCode).toBe('1001');
      expect(drLine?.debit).toBe(50000);

      const crLine = capturedLines.find((l: any) => l.credit > 0);
      expect(crLine?.accountCode).toBe('1003');
      expect(crLine?.credit).toBe(50000);

      const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
      const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
      expect(totalDebit).toBe(totalCredit);
    });

    it('includes Cr Advance from Customers line when unappliedPaise > 0', async () => {
      const receipt = makeReceipt({
        paymentMode: 'bank',
        totalAmountPaise: 60000,
        allocations: [{ allocatedPaise: 50000 }],
        unappliedPaise: 10000,
      });
      let capturedLines: any[] = [];

      mockModel.mockImplementation(function (data: any) {
        Object.assign(this, data);
        capturedLines = data.lines;
        this._id = new Types.ObjectId();
        this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
      });

      await service.postPaymentIn(receipt, paymentOpts);

      expect(capturedLines).toHaveLength(3);

      const drLine = capturedLines.find((l: any) => l.debit > 0);
      expect(drLine?.accountCode).toBe('1002'); // Bank
      expect(drLine?.debit).toBe(60000);

      const debtorsLine = capturedLines.find((l: any) => l.accountCode === '1003');
      expect(debtorsLine?.credit).toBe(50000);

      const advanceLine = capturedLines.find((l: any) => l.accountCode === '2002');
      expect(advanceLine?.credit).toBe(10000);

      const totalDebit = capturedLines.reduce((s: number, l: any) => s + l.debit, 0);
      const totalCredit = capturedLines.reduce((s: number, l: any) => s + l.credit, 0);
      expect(totalDebit).toBe(60000);
      expect(totalCredit).toBe(60000);
    });

    it('throws InternalServerErrorException when debit !== credit (corrupt receipt)', async () => {
      // unappliedPaise=5000 but totalAmountPaise=50000 and allocations=[{50000}]
      // debit=50000, credit=50000+5000=55000 → imbalance
      const receipt = makeReceipt({
        paymentMode: 'cash',
        totalAmountPaise: 50000,
        allocations: [{ allocatedPaise: 50000 }],
        unappliedPaise: 5000, // corrupt: should be 0
      });

      mockModel.mockImplementation(function (data: any) {
        Object.assign(this, data);
        this._id = new Types.ObjectId();
        this.save = jest.fn().mockResolvedValue({ ...data, _id: this._id });
      });

      await expect(service.postPaymentIn(receipt, paymentOpts)).rejects.toThrow(InternalServerErrorException);
      await expect(service.postPaymentIn(receipt, paymentOpts)).rejects.toThrow(/invariant violation/);
    });
  });
});
