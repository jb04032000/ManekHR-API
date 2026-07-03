import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentReceiptService } from './payment-receipt.service';
import { PaymentReceipt } from './payment-receipt.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { IdempotencyService } from '../../sales/common/idempotency.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { PartiesService } from '../../parties/parties.service';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeMockModel(saveResult?: any) {
  const mockSave = jest.fn().mockImplementation(function (this: any) {
    return Promise.resolve(saveResult ?? { ...this, _id: new Types.ObjectId() });
  });

  const ModelMock = jest.fn().mockImplementation(function (data: any) {
    Object.assign(this, data);
    this._id = new Types.ObjectId();
    this.save = mockSave;
  }) as any;

  ModelMock.findOne = jest.fn();
  ModelMock.findOneAndUpdate = jest.fn();
  ModelMock.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  ModelMock.find = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  });
  ModelMock.mockSave = mockSave;
  ModelMock.db = {
    transaction: jest.fn().mockImplementation((cb: any) => cb(undefined)),
  };

  return ModelMock;
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const wsId = new Types.ObjectId().toString();
const firmId = new Types.ObjectId().toString();
const partyId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();
const invoiceId = new Types.ObjectId().toString();

function makeInvoice(overrides: Partial<{
  amountDuePaise: number;
  amountPaidPaise: number;
  voucherNumber: string;
  dueDate: Date;
}> = {}) {
  return {
    _id: new Types.ObjectId(invoiceId),
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    voucherNumber: 'INV/25-26/0001',
    amountDuePaise: 100000,
    amountPaidPaise: 0,
    dueDate: new Date('2025-05-01'),
    isDeleted: false,
    ...overrides,
  };
}

function makeDto(overrides: Partial<{
  totalAmountPaise: number;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; invoiceDuePaise: number; allocatedPaise: number }>;
}> = {}) {
  return {
    financialYear: '2025-26',
    receiptDate: new Date('2025-04-01'),
    partyId,
    paymentMode: 'cash' as const,
    totalAmountPaise: 50000,
    allocations: [
      { invoiceId, invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 100000, allocatedPaise: 50000 },
    ],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PaymentReceiptService', () => {
  let service: PaymentReceiptService;
  let receiptModel: ReturnType<typeof makeMockModel>;
  let invoiceModel: ReturnType<typeof makeMockModel>;
  let ledgerPostingSvc: jest.Mocked<LedgerPostingService>;
  let idempotencySvc: jest.Mocked<IdempotencyService>;
  let voucherSeriesSvc: jest.Mocked<VoucherSeriesService>;
  let firmsSvc: jest.Mocked<FirmsService>;
  let partiesSvc: jest.Mocked<PartiesService>;

  beforeEach(async () => {
    receiptModel = makeMockModel();
    invoiceModel = makeMockModel();

    ledgerPostingSvc = { postPaymentIn: jest.fn().mockResolvedValue(undefined) } as any;
    idempotencySvc = {
      getCached: jest.fn().mockResolvedValue(null),
      store: jest.fn().mockResolvedValue(undefined),
      tryAcquireLock: jest.fn().mockResolvedValue(true),
    } as any;
    voucherSeriesSvc = {
      generateNextNumber: jest.fn().mockResolvedValue('REC/25-26/0001'),
    } as any;
    firmsSvc = {
      findOne: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(firmId),
        workspaceId: new Types.ObjectId(wsId),
        gstin: '24AAAPZ4321K2Z1',
      }),
    } as any;
    partiesSvc = {
      findOne: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(partyId), name: 'Test Party', gstin: undefined }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentReceiptService,
        { provide: getModelToken(PaymentReceipt.name), useValue: receiptModel },
        { provide: getModelToken(SaleInvoice.name), useValue: invoiceModel },
        { provide: LedgerPostingService, useValue: ledgerPostingSvc },
        { provide: IdempotencyService, useValue: idempotencySvc },
        { provide: VoucherSeriesService, useValue: voucherSeriesSvc },
        { provide: FirmsService, useValue: firmsSvc },
        { provide: PartiesService, useValue: partiesSvc },
      ],
    }).compile();

    service = module.get<PaymentReceiptService>(PaymentReceiptService);
  });

  describe('createDraft', () => {
    it('SC-1b: accepts valid allocation where allocatedPaise <= amountDuePaise', async () => {
      const invoice = makeInvoice({ amountDuePaise: 100000 });
      invoiceModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(invoice),
      });

      const dto = makeDto({ totalAmountPaise: 50000, allocations: [{ invoiceId, invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 100000, allocatedPaise: 50000 }] });
      await expect(service.createDraft(wsId, firmId, dto as any, userId)).resolves.toBeDefined();
    });

    it('SC-1b: rejects allocation when allocatedPaise > invoice.amountDuePaise', async () => {
      const invoice = makeInvoice({ amountDuePaise: 30000 });
      invoiceModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(invoice),
      });

      const dto = makeDto({ totalAmountPaise: 50000, allocations: [{ invoiceId, invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 30000, allocatedPaise: 50000 }] });
      await expect(service.createDraft(wsId, firmId, dto as any, userId)).rejects.toThrow(BadRequestException);
      await expect(service.createDraft(wsId, firmId, dto as any, userId)).rejects.toThrow(/amountDuePaise/);
    });

    it('SC-1b: rejects when sum(allocations.allocatedPaise) > totalAmountPaise', async () => {
      const invoice = makeInvoice({ amountDuePaise: 200000 });
      invoiceModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(invoice),
      });

      // allocatedPaise sum = 150000 > totalAmountPaise = 100000
      const dto = makeDto({
        totalAmountPaise: 100000,
        allocations: [{ invoiceId, invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 200000, allocatedPaise: 150000 }],
      });
      await expect(service.createDraft(wsId, firmId, dto as any, userId)).rejects.toThrow(BadRequestException);
      await expect(service.createDraft(wsId, firmId, dto as any, userId)).rejects.toThrow(/exceeds totalAmountPaise/);
    });
  });

  describe('postPaymentReceipt', () => {
    function makeDraftReceipt(overrides: any = {}) {
      return {
        _id: new Types.ObjectId(),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        financialYear: '2025-26',
        receiptDate: new Date('2025-04-01'),
        partyId: new Types.ObjectId(partyId),
        partySnapshot: { name: 'Test Party' },
        paymentMode: 'cash',
        totalAmountPaise: 50000,
        allocations: [{ invoiceId: new Types.ObjectId(invoiceId), invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 100000, allocatedPaise: 50000, runningDuePaise: 50000 }],
        unappliedPaise: 0,
        state: 'draft',
        auditLog: [],
        save: jest.fn().mockImplementation(function (this: any) { return Promise.resolve(this); }),
        ...overrides,
      };
    }

    it('SC-1b: throws BadRequestException if receipt state is not draft', async () => {
      const postedReceipt = makeDraftReceipt({ state: 'posted' });
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(postedReceipt) });

      await expect(service.postPaymentReceipt(wsId, firmId, new Types.ObjectId().toString(), userId))
        .rejects.toThrow(BadRequestException);
    });

    it('SC-1a: creates LedgerEntry with Dr Cash/Bank Cr Sundry Debtors', async () => {
      const receipt = makeDraftReceipt();
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(receipt) });

      const updatedInvoice = makeInvoice({ amountPaidPaise: 50000, amountDuePaise: 50000 });
      invoiceModel.findOne.mockReturnValue({ session: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(makeInvoice()) });
      invoiceModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedInvoice) });
      invoiceModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await service.postPaymentReceipt(wsId, firmId, receipt._id.toString(), userId);

      expect(ledgerPostingSvc.postPaymentIn).toHaveBeenCalledTimes(1);
    });

    it('SC-1a: updates invoice amountPaidPaise via $inc (not read-then-write)', async () => {
      const receipt = makeDraftReceipt();
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(receipt) });

      const updatedInvoice = makeInvoice({ amountPaidPaise: 50000, amountDuePaise: 50000 });
      invoiceModel.findOne.mockReturnValue({ session: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(makeInvoice()) });
      invoiceModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedInvoice) });
      invoiceModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await service.postPaymentReceipt(wsId, firmId, receipt._id.toString(), userId);

      // Verify $inc was used (findOneAndUpdate called with $inc)
      expect(invoiceModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: receipt.allocations[0].invoiceId }),
        expect.objectContaining({ $inc: { amountPaidPaise: 50000, amountDuePaise: -50000 } }),
        expect.any(Object),
      );
    });

    it('SC-1a: sets invoice paymentStatus to paid when amountDuePaise reaches 0', async () => {
      const receipt = makeDraftReceipt({ totalAmountPaise: 100000, allocations: [{ invoiceId: new Types.ObjectId(invoiceId), invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 100000, allocatedPaise: 100000, runningDuePaise: 0 }] });
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(receipt) });

      const updatedInvoice = makeInvoice({ amountPaidPaise: 100000, amountDuePaise: 0 });
      invoiceModel.findOne.mockReturnValue({ session: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(makeInvoice({ amountDuePaise: 100000 })) });
      invoiceModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedInvoice) });
      invoiceModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await service.postPaymentReceipt(wsId, firmId, receipt._id.toString(), userId);

      expect(invoiceModel.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ $set: { paymentStatus: 'paid' } }),
        expect.any(Object),
      );
    });

    it('SC-1a: sets invoice paymentStatus to partial when amountDuePaise > 0 and amountPaidPaise > 0', async () => {
      const receipt = makeDraftReceipt();
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(receipt) });

      const updatedInvoice = makeInvoice({ amountPaidPaise: 50000, amountDuePaise: 50000 });
      invoiceModel.findOne.mockReturnValue({ session: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(makeInvoice()) });
      invoiceModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedInvoice) });
      invoiceModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await service.postPaymentReceipt(wsId, firmId, receipt._id.toString(), userId);

      expect(invoiceModel.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ $set: { paymentStatus: 'partial' } }),
        expect.any(Object),
      );
    });

    it('SC-1a: LedgerEntry debit sum equals credit sum (invariant) — delegates to LedgerPostingService', async () => {
      // The invariant is enforced inside LedgerPostingService.postPaymentIn.
      // Here we verify postPaymentIn is called with the correct receipt shape.
      const receipt = makeDraftReceipt();
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(receipt) });

      const updatedInvoice = makeInvoice({ amountPaidPaise: 50000, amountDuePaise: 50000 });
      invoiceModel.findOne.mockReturnValue({ session: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(makeInvoice()) });
      invoiceModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedInvoice) });
      invoiceModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await service.postPaymentReceipt(wsId, firmId, receipt._id.toString(), userId);

      expect(ledgerPostingSvc.postPaymentIn).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountPaise: 50000 }),
        expect.objectContaining({ userId }),
      );
    });

    it('SC-1c: unapplied amount posts Cr Advance from Customers (2002) not Cr Debtors — receipt passed to ledger service with unappliedPaise', async () => {
      const receipt = makeDraftReceipt({
        totalAmountPaise: 60000,
        allocations: [{ invoiceId: new Types.ObjectId(invoiceId), invoiceNumber: 'INV/25-26/0001', invoiceDuePaise: 100000, allocatedPaise: 50000, runningDuePaise: 50000 }],
        unappliedPaise: 10000,
      });
      receiptModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(receipt) });

      const updatedInvoice = makeInvoice({ amountPaidPaise: 50000, amountDuePaise: 50000 });
      invoiceModel.findOne.mockReturnValue({ session: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(makeInvoice()) });
      invoiceModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updatedInvoice) });
      invoiceModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await service.postPaymentReceipt(wsId, firmId, receipt._id.toString(), userId);

      expect(ledgerPostingSvc.postPaymentIn).toHaveBeenCalledWith(
        expect.objectContaining({ unappliedPaise: 10000 }),
        expect.any(Object),
      );
    });
  });
});
