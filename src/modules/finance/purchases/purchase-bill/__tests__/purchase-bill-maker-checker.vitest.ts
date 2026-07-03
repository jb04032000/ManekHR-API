/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Finance/Bills hardening — PurchaseBill maker-checker SoD + paid-invoice guard
 * (spec D3 / OQ-FB-5 / AC-2.5).
 *
 * Covers:
 *  - post() BLOCKS self-post when makerCheckerEnabled.purchase_bill is TRUE
 *    and caller is NOT exempt (code MAKER_CHECKER_SELF_POST_BLOCKED).
 *  - post() ALLOWS self-post when the toggle is OFF (default — code path is
 *    bypassed entirely; Manager can draft and post).
 *  - post() ALLOWS a different-user post even when the toggle is ON.
 *  - post() ALLOWS an exempt caller (Owner/HR) to self-post even when toggle ON.
 *  - updateDraft() blocks update of a POSTED bill (state !== 'draft' guard AC-2.5).
 *  - Cross-workspace read: findOne with workspaceId+firmId scoping returns null for
 *    a bill from a different workspace (AC-2.6 structural proof).
 *
 * Strategy: surgically stub PurchaseBillService dependencies. We only instantiate
 * the parts we test. All heavy downstream services (LedgerPosting, TDS, ITC, etc.)
 * are irrelevant to the SoD / guard tests because the service throws BEFORE
 * reaching them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

vi.mock('@opentelemetry/api', () => {
  // finance-observability.ts calls setAttributes (plural), setStatus, recordException, end.
  // The mock must export SpanStatusCode for the import to succeed.
  const spanStub = () => ({
    end: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(), // called by withFinanceSpan
  });
  return {
    trace: {
      getTracer: () => ({
        startActiveSpan: (_n: string, fn: (s: any) => any) => fn(spanStub()),
      }),
    },
    SpanStatusCode: { OK: 'OK', ERROR: 'ERROR', UNSET: 'UNSET' },
  };
});

import { PurchaseBillService } from '../purchase-bill.service';

// ── Minimal stubs for services that are NOT on the tested code-path ─────────

function makeFirms(makerCheckerEnabled = false) {
  return {
    findOne: vi.fn().mockResolvedValue({
      _id: 'f1',
      fyStartMonth: 4,
      makerCheckerEnabled: { purchase_bill: makerCheckerEnabled },
    }),
    getDefaultGodownId: vi.fn().mockResolvedValue(null),
  };
}

function makeTds() {
  return { compute194Q: vi.fn().mockResolvedValue(null) };
}

function makeCapGoods() {
  return { createScheduleForBill: vi.fn().mockResolvedValue(undefined) };
}

function makeLedger() {
  return { postPurchaseBill: vi.fn().mockResolvedValue(undefined) };
}

function makeIdempotency() {
  return {
    getCached: vi.fn().mockResolvedValue(null),
    tryAcquireLock: vi.fn().mockResolvedValue(true),
    storeCached: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
}

function makeVoucherSeries() {
  return {
    generateNextNumber: vi.fn().mockResolvedValue('PB-001'),
    getFYForDate: vi.fn().mockReturnValue('2024-25'),
  };
}

function makeParties() {
  return { findOne: vi.fn().mockResolvedValue(null) };
}

function makeStock() {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

function makeLots() {
  return { create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }) };
}

function makeFyLock() {
  return { assertOpen: vi.fn().mockResolvedValue(undefined) };
}

function makePostHog() {
  return { capture: vi.fn() };
}

// ── PurchaseBill document stubs ──────────────────────────────────────────────

const WS_A = '6a2f26baca75116b4eee1c80';
const FIRM_A = '6a2f26baca75116b4eee1c81';
const _WS_B = '6a2f26baca75116b4eee1c82';
const _FIRM_B = '6a2f26baca75116b4eee1c83';
const USER_MANAGER = '6a2f26baca75116b4eee1c88'; // manager who created the draft
const USER_OTHER_MANAGER = '6a2f26baca75116b4eee1c89'; // a different manager

function makeDraftBill(createdByUserId: string, wsId = WS_A, firmId = FIRM_A) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    state: 'draft',
    voucherDate: new Date('2024-04-01'),
    auditLog: [{ at: new Date(), by: new Types.ObjectId(createdByUserId), action: 'created' }],
    lineItems: [],
    taxableValuePaise: 100000,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    grandTotalPaise: 100000,
    isReverseCharge: false,
    partyId: null,
    partySnapshot: {},
    save: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makePostedBill(createdByUserId: string) {
  const b = makeDraftBill(createdByUserId);
  b.state = 'posted';
  return b;
}

function buildService(pbModel: any, firms: any) {
  // Build a minimal db stub for transactions.
  const sessionStub: any = { endSession: vi.fn() };
  const dbStub = {
    transaction: async (fn: (s: any) => Promise<any>) => fn(sessionStub),
  };
  pbModel.db = dbStub;

  return new PurchaseBillService(
    pbModel,
    { findById: vi.fn().mockResolvedValue(null) } as any, // itemModel
    makeTds() as any,
    makeCapGoods() as any,
    makeLedger() as any,
    makeIdempotency() as any,
    makeVoucherSeries() as any,
    firms,
    makeParties() as any,
    makeStock() as any,
    makeLots() as any,
    makeFyLock() as any,
    makePostHog() as any,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PurchaseBillService — maker-checker / four-eyes SoD (OQ-FB-5 / spec D3)', () => {
  let draft: any;

  beforeEach(() => {
    draft = makeDraftBill(USER_MANAGER);
  });

  it('blocks self-post (MAKER_CHECKER_SELF_POST_BLOCKED) when toggle ON and caller is manager', async () => {
    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(draft) }),
    };
    const svc = buildService(pbModel, makeFirms(true /* toggle ON */));

    await expect(
      svc.post(WS_A, FIRM_A, String(draft._id), USER_MANAGER, undefined, false /* NOT exempt */),
    ).rejects.toMatchObject({ response: { code: 'MAKER_CHECKER_SELF_POST_BLOCKED' } });
  });

  it('ALLOWS self-post when toggle is OFF (default) — Manager can draft and post the same bill', async () => {
    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(draft) }),
    };
    const svc = buildService(pbModel, makeFirms(false /* toggle OFF */));

    // Even though the caller == creator, with toggle OFF the block is bypassed.
    // It would fail later (deep service calls) — but the SoD check must be skipped,
    // NOT throw MAKER_CHECKER_SELF_POST_BLOCKED. A BadRequestException for a
    // different reason (downstream) is fine; the self-post block must NOT fire.
    try {
      await svc.post(WS_A, FIRM_A, String(draft._id), USER_MANAGER, undefined, false);
    } catch (err: any) {
      // The ONLY code we must NOT see is our SoD guard.
      expect(err?.response?.code).not.toBe('MAKER_CHECKER_SELF_POST_BLOCKED');
    }
  });

  it('ALLOWS a different user (USER_OTHER_MANAGER) to post when toggle ON', async () => {
    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(draft) }),
    };
    const svc = buildService(pbModel, makeFirms(true /* toggle ON */));

    // The creator is USER_MANAGER but the poster is USER_OTHER_MANAGER → allowed.
    try {
      await svc.post(WS_A, FIRM_A, String(draft._id), USER_OTHER_MANAGER, undefined, false);
    } catch (err: any) {
      // Must not be the SoD block — the different user should pass that check.
      expect(err?.response?.code).not.toBe('MAKER_CHECKER_SELF_POST_BLOCKED');
    }
  });

  it('ALLOWS Owner/HR (isExempt=true) to self-post even when toggle ON', async () => {
    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(draft) }),
    };
    const svc = buildService(pbModel, makeFirms(true /* toggle ON */));

    // isExemptFromMakerChecker=true means Owner/HR — must bypass the block.
    try {
      await svc.post(WS_A, FIRM_A, String(draft._id), USER_MANAGER, undefined, true /* EXEMPT */);
    } catch (err: any) {
      expect(err?.response?.code).not.toBe('MAKER_CHECKER_SELF_POST_BLOCKED');
    }
  });
});

describe('PurchaseBillService — posted bill read-only guard (AC-2.5)', () => {
  it('updateDraft() throws BadRequestException for a POSTED bill (state guard)', async () => {
    const posted = makePostedBill(USER_MANAGER);
    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(posted) }),
      findOneAndUpdate: vi.fn(),
    };
    pbModel.db = { transaction: (fn: any) => Promise.resolve().then(() => fn({})) };

    const svc = buildService(pbModel, makeFirms(false));

    await expect(
      svc.updateDraft(WS_A, FIRM_A, String(posted._id), {}, USER_MANAGER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PurchaseBillService — cross-workspace isolation (AC-2.6)', () => {
  it('softDelete (DELETE :id) returns NotFoundException when bill is not in the route workspace', async () => {
    // Simulates: a WS_B bill queried under WS_A+FIRM_A — Mongo returns null.
    const BILL_B_ID = '6a2f26baca75116b4eee1c99';

    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      findOneAndUpdate: vi.fn(),
    };
    pbModel.db = { transaction: (fn: any) => Promise.resolve().then(() => fn({})) };
    const svc = buildService(pbModel, makeFirms(false));

    // softDelete calls findOne internally (which returns null → NotFoundException).
    await expect(svc.softDelete(WS_A, FIRM_A, BILL_B_ID, USER_MANAGER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // No write happened.
    expect(pbModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('the findOne query always includes both workspaceId AND firmId as the scope fence', async () => {
    // Structural proof: findOne filter must include workspace+firm to prevent
    // cross-workspace + cross-firm data leaks. The mock captures the filter.
    const BILL_B_ID = '6a2f26baca75116b4eee1c99';

    const pbModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    };
    pbModel.db = { transaction: (fn: any) => Promise.resolve().then(() => fn({})) };
    const svc = buildService(pbModel, makeFirms(false));

    // Direct call to findOne (returns null, not throws — only callers throw).
    await svc.findOne(WS_A, FIRM_A, BILL_B_ID);

    const filter = pbModel.findOne.mock.calls[0][0];
    expect(filter.workspaceId.toString()).toBe(WS_A); // scoped to WS_A
    expect(filter.firmId.toString()).toBe(FIRM_A); // scoped to FIRM_A
    expect(filter.isDeleted).toBe(false); // soft-deleted bills excluded
  });
});
