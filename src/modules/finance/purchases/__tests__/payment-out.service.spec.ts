import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { PaymentOutService } from '../payment-out/payment-out.service';
import { financialYearOf } from '../../common/fiscal-year.util';

// ─── Fixture factories ────────────────────────────────────────────────────────

const wsId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const firmId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const userId = 'cccccccccccccccccccccccc';
const partyId = new Types.ObjectId();
const billId = new Types.ObjectId();

function makePaymentOutDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    financialYear: '2025-26',
    paymentDate: new Date('2025-08-01'),
    partyId,
    partySnapshot: { name: 'Vendor A' },
    paymentMode: 'bank',
    totalAmountPaise: 50_000_00,
    billAllocations: [
      {
        billId,
        billNumber: 'PB/25-26/001',
        billDuePaise: 50_000_00,
        allocatedPaise: 50_000_00,
        runningDuePaise: 0,
      },
    ],
    unappliedPaise: 0,
    state: 'draft',
    auditLog: [],
    save: vi.fn().mockResolvedValue({ state: 'posted' }),
    ...overrides,
  };
}

function makeBillDoc(amountDuePaise = 50_000_00) {
  return {
    _id: billId,
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    voucherNumber: 'PB/25-26/001',
    amountDuePaise,
    amountPaidPaise: 0,
    state: 'posted',
    paymentStatus: 'unpaid',
  };
}

function makeDependencies(overrides: Record<string, any> = {}) {
  const paymentOut = makePaymentOutDoc();
  const bill = makeBillDoc();
  return {
    model: {
      findOne: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(paymentOut),
      }),
      db: { transaction: vi.fn().mockImplementation((fn: any) => fn({ id: 'session' })) },
      ...overrides.model,
    },
    billModel: {
      findOne: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(bill),
      }),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          ...bill,
          amountDuePaise: 0,
          amountPaidPaise: bill.amountDuePaise,
        }),
      }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      ...overrides.billModel,
    },
    tdsService: {
      computeAtPaymentOut: vi.fn().mockResolvedValue(null),
      ...overrides.tdsService,
    },
    ledgerPostingService: {
      postPaymentOut: vi.fn().mockResolvedValue(undefined),
      ...overrides.ledgerPostingService,
    },
    idempotencyService: {
      getCached: vi.fn().mockResolvedValue(null),
      tryAcquireLock: vi.fn().mockResolvedValue(true),
      store: vi.fn().mockResolvedValue(undefined),
      ...overrides.idempotencyService,
    },
    voucherSeriesService: {
      generateNextNumber: vi.fn().mockResolvedValue('POUT/25-26/001'),
      getFYForDate: vi.fn((d: Date, m = 4) => financialYearOf(d, m)),
      ...overrides.voucherSeriesService,
    },
    firmsService: {
      findOne: vi.fn().mockResolvedValue({
        _id: new Types.ObjectId(firmId),
        workspaceId: new Types.ObjectId(wsId),
      }),
      ...overrides.firmsService,
    },
    partiesService: {
      findOne: vi.fn().mockResolvedValue({
        _id: partyId,
        pan: 'ABCDE1234F',
        supplierType: null,
        deducteeStatus: null,
      }),
      ...overrides.partiesService,
    },
    fyLock: {
      assertOpen: vi.fn().mockResolvedValue(undefined),
      ...overrides.fyLock,
    },
    _paymentOut: paymentOut,
    _bill: bill,
  };
}

function makeService(deps: ReturnType<typeof makeDependencies>) {
  return new PaymentOutService(
    deps.model,
    deps.billModel,
    deps.tdsService,
    deps.ledgerPostingService,
    deps.idempotencyService,
    deps.voucherSeriesService,
    deps.firmsService,
    deps.partiesService,
    deps.fyLock,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PaymentOutService.post', () => {
  it('SC-1: calls ledgerPostingService.postPaymentOut inside transaction', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.ledgerPostingService.postPaymentOut).toHaveBeenCalledTimes(1);
  });

  it('SC-1: post() runs inside MongoDB transaction (conn.transaction called)', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.model.db.transaction).toHaveBeenCalledTimes(1);
  });

  it('SC-1: allocations use $inc on bill.amountPaidPaise / amountDuePaise', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.billModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: billId }),
      {
        $inc: {
          amountPaidPaise: deps._paymentOut.billAllocations[0].allocatedPaise,
          amountDuePaise: -deps._paymentOut.billAllocations[0].allocatedPaise,
        },
      },
      expect.objectContaining({ new: true }),
    );
  });

  it('SC-1: bill allocation rejects when allocatedPaise > bill.amountDuePaise (inside transaction)', async () => {
    const billWithLessdue = makeBillDoc(1_000_00); // only ₹1k due
    const paymentOut = makePaymentOutDoc({
      billAllocations: [
        {
          billId,
          billNumber: 'PB/25-26/001',
          billDuePaise: 50_000_00,
          allocatedPaise: 50_000_00,
          runningDuePaise: 0,
        },
      ],
    });
    const deps = makeDependencies({
      model: {
        findOne: vi.fn().mockReturnValue({
          session: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue(paymentOut),
        }),
        db: { transaction: vi.fn().mockImplementation((fn: any) => fn({ id: 'session' })) },
      },
      billModel: {
        findOne: vi.fn().mockReturnValue({
          session: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue(billWithLessdue),
        }),
        findOneAndUpdate: vi.fn(),
        updateOne: vi.fn(),
      },
    });
    const svc = makeService(deps);
    await expect(svc.post(wsId, firmId, paymentOut._id.toString(), userId)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('SC-2: calls TdsService.computeAtPaymentOut at post time', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.tdsService.computeAtPaymentOut).toHaveBeenCalledTimes(1);
  });

  it('SC-2: rate 0.01 (1%) — contractor individual_huf — propagated from TdsService result', async () => {
    const tdsResult = {
      section: 'sec_194c',
      rate: 0.01,
      basePaise: 50_000_00,
      tdsPaise: 5_000,
      cumulativeBeforePaise: 0,
    };
    const deps = makeDependencies({
      tdsService: { computeAtPaymentOut: vi.fn().mockResolvedValue(tdsResult) },
      partiesService: {
        findOne: vi.fn().mockResolvedValue({
          _id: partyId,
          pan: 'ABCDE1234F',
          supplierType: 'contractor',
          deducteeStatus: 'individual_huf',
        }),
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.tdsService.computeAtPaymentOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ supplierType: 'contractor', deducteeStatus: 'individual_huf' }),
      expect.any(Number),
      expect.any(String),
      expect.anything(),
    );
  });

  it('SC-2: rate 0.02 (2%) — contractor company_firm — TdsService invoked with correct party data', async () => {
    const deps = makeDependencies({
      partiesService: {
        findOne: vi.fn().mockResolvedValue({
          _id: partyId,
          pan: 'ABCDE1234F',
          supplierType: 'contractor',
          deducteeStatus: 'company_firm',
        }),
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.tdsService.computeAtPaymentOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ supplierType: 'contractor', deducteeStatus: 'company_firm' }),
      expect.any(Number),
      expect.any(String),
      expect.anything(),
    );
  });

  it('SC-2: rate 0.05 (5%) — broker 194H — TdsService invoked with supplierType=broker', async () => {
    const deps = makeDependencies({
      partiesService: {
        findOne: vi.fn().mockResolvedValue({
          _id: partyId,
          pan: 'ABCDE1234F',
          supplierType: 'broker',
          deducteeStatus: null,
        }),
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.tdsService.computeAtPaymentOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ supplierType: 'broker' }),
      expect.any(Number),
      expect.any(String),
      expect.anything(),
    );
  });

  it('SC-2: rate 0.10 (10%) — professional 194J — TdsService invoked with supplierType=professional', async () => {
    const deps = makeDependencies({
      partiesService: {
        findOne: vi.fn().mockResolvedValue({
          _id: partyId,
          pan: 'ABCDE1234F',
          supplierType: 'professional',
          deducteeStatus: null,
        }),
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.tdsService.computeAtPaymentOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ supplierType: 'professional' }),
      expect.any(Number),
      expect.any(String),
      expect.anything(),
    );
  });

  it('SC-2: no PAN (20%) — TdsService invoked with pan=undefined', async () => {
    const deps = makeDependencies({
      partiesService: {
        findOne: vi.fn().mockResolvedValue({
          _id: partyId,
          pan: undefined,
          supplierType: 'contractor',
          deducteeStatus: 'individual_huf',
        }),
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._paymentOut._id.toString(), userId);
    expect(deps.tdsService.computeAtPaymentOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ pan: undefined }),
      expect.any(Number),
      expect.any(String),
      expect.anything(),
    );
  });

  it('SC-1: blocks re-post when state !== draft', async () => {
    const postedDoc = makePaymentOutDoc({ state: 'posted' });
    const deps = makeDependencies({
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(postedDoc) }),
        db: {},
      },
    });
    const svc = makeService(deps);
    await expect(svc.post(wsId, firmId, postedDoc._id.toString(), userId)).rejects.toThrow(
      BadRequestException,
    );
  });
});
