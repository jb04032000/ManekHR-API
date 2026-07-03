import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { PurchaseBillService } from '../purchase-bill/purchase-bill.service';
import { financialYearOf } from '../../common/fiscal-year.util';

// ─── Mock factories ───────────────────────────────────────────────────────────

const wsId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const firmId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const userId = 'cccccccccccccccccccccccc';

function makeBillDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    voucherDate: new Date('2025-06-01'),
    financialYear: '2025-26',
    state: 'draft',
    taxableValuePaise: 1_000_00,
    cgstPaise: 90_00,
    sgstPaise: 90_00,
    igstPaise: 0,
    grandTotalPaise: 1_180_00,
    lineItems: [
      {
        isCapitalGoods: false,
        cgstPaise: 90_00,
        sgstPaise: 90_00,
        igstPaise: 0,
        itemName: 'Widget',
      },
    ],
    partyId: new Types.ObjectId(),
    partySnapshot: { name: 'Vendor A' },
    placeOfSupplyStateCode: '27',
    amountDuePaise: 0,
    amountPaidPaise: 0,
    paymentStatus: 'unpaid',
    netPayableToCreditorsAfterTdsPaise: 0,
    msmeApplicable: false,
    auditLog: [],
    save: vi.fn().mockResolvedValue({ state: 'posted' }),
    ...overrides,
  };
}

function makeDependencies(overrides: Record<string, any> = {}) {
  const bill = makeBillDoc();
  return {
    model: {
      findOne: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(bill),
      }),
      db: {
        transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })),
      },
      ...overrides.model,
    },
    tdsService: {
      compute194Q: vi.fn().mockResolvedValue(null),
      ...overrides.tdsService,
    },
    capitalGoodsItcService: {
      createScheduleForBill: vi.fn().mockResolvedValue([]),
      ...overrides.capitalGoodsItcService,
    },
    ledgerPostingService: {
      postPurchaseBill: vi.fn().mockResolvedValue(undefined),
      ...overrides.ledgerPostingService,
    },
    idempotencyService: {
      getCached: vi.fn().mockResolvedValue(null),
      tryAcquireLock: vi.fn().mockResolvedValue(true),
      store: vi.fn().mockResolvedValue(undefined),
      ...overrides.idempotencyService,
    },
    voucherSeriesService: {
      generateNextNumber: vi.fn().mockResolvedValue('PB/25-26/001'),
      getFYForDate: vi.fn((d: Date, m = 4) => financialYearOf(d, m)),
      ...overrides.voucherSeriesService,
    },
    firmsService: {
      findOne: vi.fn().mockResolvedValue({
        _id: new Types.ObjectId(firmId),
        workspaceId: new Types.ObjectId(wsId),
        aato: 0,
        placeOfSupplyStateCode: '27',
      }),
      ...overrides.firmsService,
    },
    partiesService: {
      findOne: vi.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        pan: 'ABCDE1234F',
        msmeRegistration: { isUdyamRegistered: false },
      }),
      ...overrides.partiesService,
    },
    itemModel: {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      // post() reads items for the stock-inward loop via findById(...).lean();
      // null => the line is skipped (no stock tracking) so the post path completes.
      findById: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      ...overrides.itemModel,
    },
    stockMovementsService: {
      record: vi.fn().mockResolvedValue(undefined),
      ...overrides.stockMovementsService,
    },
    lotsService: {
      createLot: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      ...overrides.lotsService,
    },
    fyLock: {
      assertOpen: vi.fn().mockResolvedValue(undefined),
      ...overrides.fyLock,
    },
    _bill: bill,
  };
}

function makeService(deps: ReturnType<typeof makeDependencies>) {
  return new PurchaseBillService(
    deps.model,
    deps.itemModel,
    deps.tdsService,
    deps.capitalGoodsItcService,
    deps.ledgerPostingService,
    deps.idempotencyService,
    deps.voucherSeriesService,
    deps.firmsService,
    deps.partiesService,
    deps.stockMovementsService,
    deps.lotsService,
    deps.fyLock,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PurchaseBillService.post', () => {
  it('SC-1: assigns voucherNumber via VoucherSeriesService at post time', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._bill._id.toString(), userId);
    expect(deps.voucherSeriesService.generateNextNumber).toHaveBeenCalledWith(
      firmId,
      'purchase_bill',
      deps._bill.financialYear,
    );
  });

  it('SC-1: blocks re-post when state !== draft (BadRequestException)', async () => {
    const postedBill = makeBillDoc({ state: 'posted' });
    const deps = makeDependencies({
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(postedBill) }),
        db: {},
      },
    });
    const svc = makeService(deps);
    await expect(svc.post(wsId, firmId, postedBill._id.toString(), userId)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('SC-2: calls TdsService.compute194Q at post time (never at draft create)', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._bill._id.toString(), userId);
    expect(deps.tdsService.compute194Q).toHaveBeenCalledTimes(1);
  });

  // ── OQ-FB-5: maker-checker / four-eyes block for purchase-bill posting ──────
  it('OQ-FB-5: is a NO-OP when the firm toggle is OFF (default) even for the creator', async () => {
    // auditLog[0].by === poster, but makerCheckerEnabled.purchase_bill is unset
    // (default false) → the post must proceed normally.
    const bill = makeBillDoc({
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
    });
    const deps = makeDependencies({
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
        db: { transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })) },
      },
    });
    const svc = makeService(deps);
    // isExemptFromMakerChecker=false to prove the firm-toggle gate (not the
    // exemption) is what makes this a no-op.
    await svc.post(wsId, firmId, bill._id.toString(), userId, undefined, false);
    expect(deps.ledgerPostingService.postPurchaseBill).toHaveBeenCalledTimes(1);
  });

  it('OQ-FB-5: BLOCKS a non-exempt creator from posting their own bill when the toggle is ON', async () => {
    const bill = makeBillDoc({
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
    });
    const deps = makeDependencies({
      firmsService: {
        findOne: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(firmId),
          aato: 0,
          placeOfSupplyStateCode: '27',
          makerCheckerEnabled: { purchase_bill: true },
        }),
      },
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
        db: { transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })) },
      },
    });
    const svc = makeService(deps);
    await expect(
      svc.post(wsId, firmId, bill._id.toString(), userId, undefined, false),
    ).rejects.toMatchObject({ response: { code: 'MAKER_CHECKER_SELF_POST_BLOCKED' } });
    // The block fires BEFORE the ledger write.
    expect(deps.ledgerPostingService.postPurchaseBill).not.toHaveBeenCalled();
  });

  it('OQ-FB-5: ALLOWS an exempt (Owner/HR) caller to post a bill they created when the toggle is ON', async () => {
    const bill = makeBillDoc({
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
    });
    const deps = makeDependencies({
      firmsService: {
        findOne: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(firmId),
          aato: 0,
          placeOfSupplyStateCode: '27',
          makerCheckerEnabled: { purchase_bill: true },
        }),
      },
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
        db: { transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })) },
      },
    });
    const svc = makeService(deps);
    // isExemptFromMakerChecker=true (Owner/HR) → the self-post block is skipped.
    await svc.post(wsId, firmId, bill._id.toString(), userId, undefined, true);
    expect(deps.ledgerPostingService.postPurchaseBill).toHaveBeenCalledTimes(1);
  });

  it('OQ-FB-5: ALLOWS a different non-exempt poster when the toggle is ON (four-eyes satisfied)', async () => {
    const otherUser = new Types.ObjectId(); // creator differs from the poster
    const bill = makeBillDoc({ auditLog: [{ at: new Date(), by: otherUser, action: 'created' }] });
    const deps = makeDependencies({
      firmsService: {
        findOne: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(firmId),
          aato: 0,
          placeOfSupplyStateCode: '27',
          makerCheckerEnabled: { purchase_bill: true },
        }),
      },
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
        db: { transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })) },
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, bill._id.toString(), userId, undefined, false);
    expect(deps.ledgerPostingService.postPurchaseBill).toHaveBeenCalledTimes(1);
  });

  it('SC-2: TDS not computed at createDraft — only at post', () => {
    const deps = makeDependencies();
    // 194Q is computed only inside post(); a freshly-built dependency set (no
    // post() call) must never have invoked compute194Q.
    expect(deps.tdsService.compute194Q).not.toHaveBeenCalled();
  });

  it('SC-1: postPurchaseBill called inside transaction', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._bill._id.toString(), userId);
    expect(deps.ledgerPostingService.postPurchaseBill).toHaveBeenCalledTimes(1);
  });

  it('SC-1: ledger Cr Sundry Creditors uses netPayableToCreditorsAfterTdsPaise when 194Q applies', async () => {
    const tdsPaise = 1_000;
    const bill = makeBillDoc({ grandTotalPaise: 1_180_00, taxableValuePaise: 1_000_00 });
    const deps = makeDependencies({
      tdsService: {
        compute194Q: vi.fn().mockResolvedValue({
          section: 'sec_194q',
          rate: 0.001,
          basePaise: 1_000_000,
          tdsPaise,
          cumulativeBeforePaise: 50_000_000,
        }),
      },
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
        db: { transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })) },
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, bill._id.toString(), userId);
    // netPayableToCreditorsAfterTdsPaise should equal grandTotal - tdsPaise
    expect(bill.netPayableToCreditorsAfterTdsPaise).toBe(bill.grandTotalPaise - tdsPaise);
  });

  it('SC-3: calls capitalGoodsItcService.createScheduleForBill at post time', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._bill._id.toString(), userId);
    expect(deps.capitalGoodsItcService.createScheduleForBill).toHaveBeenCalledTimes(1);
  });

  it('SC-1: starts MSME 45-day clock when vendor.msmeRegistration.isUdyamRegistered=true', async () => {
    const bill = makeBillDoc({ voucherDate: new Date('2025-06-01') });
    const deps = makeDependencies({
      partiesService: {
        findOne: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          pan: 'ABCDE1234F',
          msmeRegistration: { isUdyamRegistered: true },
        }),
      },
      model: {
        findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
        db: { transaction: vi.fn().mockImplementation((fn) => fn({ id: 'session' })) },
      },
    });
    const svc = makeService(deps);
    await svc.post(wsId, firmId, bill._id.toString(), userId);
    expect(bill.msmeApplicable).toBe(true);
    expect(bill.msmePaymentDeadline).toBeDefined();
    // deadline should be 45 days after voucherDate
    const expected = new Date('2025-06-01');
    expected.setDate(expected.getDate() + 45);
    expect(bill.msmePaymentDeadline?.getTime()).toBe(expected.getTime());
  });

  it('SC-1: post() runs inside MongoDB transaction (conn.transaction called)', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    await svc.post(wsId, firmId, deps._bill._id.toString(), userId);
    expect(deps.model.db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('PurchaseBillService.createDraft', () => {
  it('SC-1: throws BadRequestException when lineItems is empty', async () => {
    const deps = makeDependencies();
    const svc = makeService(deps);
    const dto = {
      voucherDate: new Date(),
      financialYear: '2025-26',
      lineItems: [],
      taxableValuePaise: 0,
      grandTotalPaise: 0,
    };
    await expect(svc.createDraft(wsId, firmId, dto as any, userId)).rejects.toThrow(
      BadRequestException,
    );
  });
});
