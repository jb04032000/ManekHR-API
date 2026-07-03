import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { SaleInvoiceService } from './sale-invoice.service';
import { SaleInvoice } from './sale-invoice.schema';
import { TaxComputationService } from '../tax-computation/tax-computation.service';
import { LedgerPostingService } from '../ledger-posting/ledger-posting.service';
import { PartySalesAggregateService } from '../party-sales-aggregate/party-sales-aggregate.service';
import { InventoryService } from '../inventory/inventory.service';
import { IdempotencyService } from '../common/idempotency.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { PartiesService } from '../../parties/parties.service';
import { MailService } from '../../../mail/mail.service';
import { PrintService } from '../print/print.service';

// ─── Mock factory helpers ────────────────────────────────────────────────────

const wsId = new Types.ObjectId().toString();
const firmId = new Types.ObjectId().toString();
const partyId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();
const invoiceId = new Types.ObjectId().toString();

interface MockInvoice {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  firmId: Types.ObjectId;
  partyId: Types.ObjectId;
  partySnapshot: Record<string, any>;
  voucherType: string;
  voucherDate: Date;
  state: string;
  lineItems: any[];
  additionalCharges: any[];
  linkedDocs: any[];
  auditLog: any[];
  placeOfSupplyStateCode: string;
  paymentTerms: { termsDays: number };
  isDeleted: boolean;
  subtotalPaise: number;
  totalDiscountPaise: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  tcsPaise: number;
  roundOffPaise: number;
  grandTotalPaise: number;
  amountPaidPaise: number;
  amountDuePaise: number;
  paymentStatus: string;
  eInvoice: { status: string; attempts: number };
  voucherNumber?: string;
  amountInWords?: string;
  postedAt?: Date;
  postedBy?: Types.ObjectId;
  tcsApplied?: any;
  lateFeeSchedule?: any;
  dueDate?: Date;
  razorpayPaymentLinkId?: string;
  toObject: () => Record<string, any>;
  save: jest.Mock;
  [key: string]: any;
}

function makeMockInvoice(overrides: Partial<MockInvoice> = {}): MockInvoice {
  const inv: MockInvoice = {
    _id: new Types.ObjectId(invoiceId),
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    partyId: new Types.ObjectId(partyId),
    partySnapshot: { name: 'Test Party', gstin: '24AAAAA0000A1Z5' },
    voucherType: 'sale_invoice',
    voucherDate: new Date('2025-06-01'),
    state: 'draft',
    lineItems: [],
    additionalCharges: [],
    linkedDocs: [],
    auditLog: [],
    placeOfSupplyStateCode: '24',
    paymentTerms: { termsDays: 30 },
    isDeleted: false,
    subtotalPaise: 0,
    totalDiscountPaise: 0,
    taxableValuePaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    cessPaise: 0,
    tcsPaise: 0,
    roundOffPaise: 0,
    grandTotalPaise: 0,
    amountPaidPaise: 0,
    amountDuePaise: 0,
    paymentStatus: 'unpaid',
    eInvoice: { status: 'not_applicable', attempts: 0 },
    toObject() {
      return { ...this };
    },
    save: jest.fn(),
    ...overrides,
  };
  // save returns the invoice itself by default
  inv.save.mockResolvedValue(inv);
  return inv;
}

function makeMockFirm(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(firmId),
    workspaceId: new Types.ObjectId(wsId),
    gstin: '24AAAAA0000A1Z5',
    fyStartMonth: 4,
    roundingPolicy: 'half_up',
    aato: 50,
    lateFeePct: 18,
    makerCheckerEnabled: {
      sale_invoice: false,
    },
    accountsBooksBeginDate: null,
    ...overrides,
  };
}

const mockTaxResult = {
  lines: [],
  subtotalPaise: 118000,
  totalDiscountPaise: 0,
  taxableValuePaise: 100000,
  additionalChargesPaise: 0,
  cgstPaise: 9000,
  sgstPaise: 9000,
  igstPaise: 0,
  cessPaise: 0,
  tcsPaise: 0,
  roundOffPaise: 0,
  grandTotalPaise: 118000,
};

// ─── Mock model with transaction pass-through ────────────────────────────────
// Per plan: { db: { transaction: async (fn) => fn(null) } } — null session pass-through

function makeMockModel(invoice: MockInvoice) {
  const model: any = function () {
    return invoice;
  };
  model.findOne = jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(invoice),
  });
  model.find = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([invoice]) }),
  });
  model.countDocuments = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(1) });
  model.db = {
    transaction: async (fn: (session: any) => Promise<any>) => fn(null),
  };
  return model;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('SaleInvoiceService', () => {
  let service: SaleInvoiceService;

  // typed as any to avoid complex Partial<T> cast issues with jest.spyOn
  let mockTax: any;
  let mockLedger: any;
  let mockPartyAggregate: any;
  let mockInventory: any;
  let mockIdempotency: any;
  let mockVoucherSeries: any;
  let mockFirms: any;
  let mockParties: any;

  let invoice: MockInvoice;

  beforeEach(async () => {
    invoice = makeMockInvoice();

    const mockModel = makeMockModel(invoice);

    mockTax = {
      compute: jest.fn().mockReturnValue(mockTaxResult),
    };

    mockLedger = {
      postSaleInvoice: jest.fn().mockResolvedValue({}),
      postSaleInvoiceReverse: jest.fn().mockResolvedValue({}),
    };

    mockPartyAggregate = {
      upsertAndGet: jest.fn().mockResolvedValue({ beforePaise: 0, afterPaise: 100000 }),
      computeTcs: jest.fn().mockReturnValue(0),
      revert: jest.fn().mockResolvedValue(undefined),
    };

    mockInventory = {
      stockOut: jest.fn().mockResolvedValue(undefined),
      stockIn: jest.fn().mockResolvedValue(undefined),
      releaseReservation: jest.fn().mockResolvedValue(undefined),
      reserve: jest.fn().mockResolvedValue(undefined),
    };

    mockIdempotency = {
      getCached: jest.fn().mockResolvedValue(null),
      store: jest.fn().mockResolvedValue(undefined),
    };

    mockVoucherSeries = {
      getCurrentFY: jest.fn().mockReturnValue('2025-26'),
      generateNextNumber: jest.fn().mockResolvedValue('INV/25-26/0001'),
    };

    mockFirms = {
      findOne: jest.fn().mockResolvedValue(makeMockFirm()),
    };

    mockParties = {
      findOne: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(partyId),
        name: 'Test Party',
        gstin: '24AAAAA0000A1Z5',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SaleInvoiceService,
        { provide: getModelToken(SaleInvoice.name), useValue: mockModel },
        { provide: TaxComputationService, useValue: mockTax },
        { provide: LedgerPostingService, useValue: mockLedger },
        { provide: PartySalesAggregateService, useValue: mockPartyAggregate },
        { provide: InventoryService, useValue: mockInventory },
        { provide: IdempotencyService, useValue: mockIdempotency },
        { provide: VoucherSeriesService, useValue: mockVoucherSeries },
        { provide: FirmsService, useValue: mockFirms },
        { provide: PartiesService, useValue: mockParties },
        // Wave 5 additions — mocked so existing tests are unaffected
        {
          provide: MailService,
          useValue: { sendInvoiceEmail: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PrintService,
          useValue: { generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')) },
        },
      ],
    }).compile();

    service = module.get<SaleInvoiceService>(SaleInvoiceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── Test 1: Idempotency double-post ─────────────────────────────────────

  it('returns cached response on duplicate idempotencyKey', async () => {
    const cachedInvoice = { ...invoice.toObject(), state: 'posted' };
    mockIdempotency.getCached.mockResolvedValueOnce(cachedInvoice);

    const result = await service.postInvoice(wsId, firmId, invoiceId, userId, 'idem-key-123');

    expect(result).toEqual(cachedInvoice);
    // Tax should NOT be computed — idempotency cache hit means pipeline skipped
    expect(mockTax.compute).not.toHaveBeenCalled();
    expect(mockIdempotency.getCached).toHaveBeenCalledWith(
      `post-invoice:${firmId}`,
      'idem-key-123',
    );
  });

  // ─── Test 2: FY backdating rejection ────────────────────────────────────

  it('throws BadRequestException on closed-FY backdated invoice', async () => {
    const today = new Date('2025-08-15');
    invoice.voucherDate = new Date('2025-04-01');
    mockFirms.findOne.mockResolvedValue(makeMockFirm({ accountsBooksBeginDate: today }));

    await expect(service.postInvoice(wsId, firmId, invoiceId, userId)).rejects.toThrow(
      BadRequestException,
    );

    await expect(service.postInvoice(wsId, firmId, invoiceId, userId)).rejects.toThrow(
      'closed financial year',
    );
  });

  // ─── Test 3: Maker-checker routing ──────────────────────────────────────

  it('routes to pending_approval when maker-checker enabled', async () => {
    mockFirms.findOne.mockResolvedValue(
      makeMockFirm({ makerCheckerEnabled: { sale_invoice: true } }),
    );

    await service.postInvoice(wsId, firmId, invoiceId, userId);

    expect(invoice.state).toBe('pending_approval');
    // Ledger + inventory must NOT be called
    expect(mockLedger.postSaleInvoice).not.toHaveBeenCalled();
    expect(mockInventory.stockOut).not.toHaveBeenCalled();
  });

  // ─── Test 4: Normal Post (ledger + inventory called) ────────────────────

  it('posts ledger and updates inventory on normal Post', async () => {
    await service.postInvoice(wsId, firmId, invoiceId, userId);

    // Ledger posted once
    expect(mockLedger.postSaleInvoice).toHaveBeenCalledTimes(1);
    // StockOut called once
    expect(mockInventory.stockOut).toHaveBeenCalledTimes(1);
    // Invoice state = posted
    expect(invoice.state).toBe('posted');
    // VoucherNumber assigned and matches expected format
    expect(invoice.voucherNumber).toMatch(/^INV\/\d{2}-\d{2}\/\d+$/);
  });

  // ─── Test 5: amountInWords snapshot ─────────────────────────────────────

  it('snapshots amountInWords from grandTotalPaise', async () => {
    // grandTotalPaise = 118000 (₹1180.00) → "Rupees One Thousand One Hundred Eighty Only"
    await service.postInvoice(wsId, firmId, invoiceId, userId);

    expect(invoice.voucherNumber).toBeDefined();
    expect(invoice.amountInWords).toBeDefined();
    expect(invoice.amountInWords).toMatch(/^Rupees/);
  });

  // ─── Test 6: findByPaymentLinkId workspace-scoped ────────────────────────

  it('findByPaymentLinkId returns invoice across all firms in workspace', async () => {
    const paymentLinkId = 'plink_xyz123';
    const invoiceWithLink = { ...invoice, razorpayPaymentLinkId: paymentLinkId };

    // Override model.findOne for this specific call
    const modelRef = service['model'] as any;
    modelRef.findOne = jest.fn().mockResolvedValueOnce(invoiceWithLink);

    const result = await service.findByPaymentLinkId(wsId, paymentLinkId);

    // Should call findOne with workspaceId + paymentLinkId, but NO firmId
    expect(modelRef.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.any(Types.ObjectId),
        razorpayPaymentLinkId: paymentLinkId,
        isDeleted: false,
      }),
    );
    // Verify firmId is NOT in the filter (workspace-scoped only)
    const callArgs = modelRef.findOne.mock.calls[0][0];
    expect(callArgs.firmId).toBeUndefined();

    expect(result).toEqual(invoiceWithLink);
  });
});
