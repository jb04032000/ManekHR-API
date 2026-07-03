/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing VoucherSeriesService so
// that the transitive schema decorations don't trip the "Cannot determine type"
// reflection error under vitest's esbuild transform.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { Types } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { VoucherSeriesService } from '../voucher-series.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a chainable query stub: .sort().exec() resolves to `result`. */
function makeSortExecChain(result: any) {
  return {
    sort: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(result),
    }),
    exec: vi.fn().mockResolvedValue(result),
  };
}

/** Build a simple .exec() stub resolving to `result`. */
function makeExecChain(result: any) {
  return { exec: vi.fn().mockResolvedValue(result) };
}

// Stable ObjectIds reused across tests.
const WORKSPACE_ID = new Types.ObjectId();
const FIRM_ID = new Types.ObjectId();
const FIRM_ID_STR = FIRM_ID.toHexString();

// ---------------------------------------------------------------------------
// Suite A: resolveCarryForwardConfig (pure helper, no model needed)
// ---------------------------------------------------------------------------

describe('VoucherSeriesService.resolveCarryForwardConfig', () => {
  // We construct a minimal service just to call the pure method; model is never
  // accessed so passing null is fine.
  const svc = new VoucherSeriesService(null as any);

  it('returns prefix + padDigits from prior when prior exists', () => {
    const prior = { prefix: 'INV', padDigits: 5 } as any;
    expect(svc.resolveCarryForwardConfig(prior, 'sale_invoice')).toEqual({
      prefix: 'INV',
      padDigits: 5,
    });
  });

  it('falls back to DEFAULT_SERIES prefix when prior is null and voucherType is known', () => {
    expect(svc.resolveCarryForwardConfig(null, 'sale_invoice')).toEqual({
      prefix: 'INV',
      padDigits: 4,
    });
    expect(svc.resolveCarryForwardConfig(null, 'purchase_bill')).toEqual({
      prefix: 'PB',
      padDigits: 4,
    });
    expect(svc.resolveCarryForwardConfig(null, 'payment_in')).toEqual({
      prefix: 'REC',
      padDigits: 4,
    });
  });

  it('derives prefix from voucherType when prior is null and voucherType is unknown', () => {
    // "custom_voucher_type" -> strip non-alpha -> "CUSTOMVOUCHERTYPE" -> first 3 -> "CUS"
    const result = svc.resolveCarryForwardConfig(null, 'custom_voucher_type');
    expect(result.prefix).toBe('CUS');
    expect(result.padDigits).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Suite B: generateNextNumber -- existing FY row (fast path, no self-heal)
// ---------------------------------------------------------------------------

describe('VoucherSeriesService.generateNextNumber -- existing FY row', () => {
  let model: any;
  let svc: VoucherSeriesService;

  const existingDoc = {
    prefix: 'INV',
    padDigits: 4,
    lastUsed: 3,
    workspaceId: WORKSPACE_ID,
    firmId: FIRM_ID,
    voucherType: 'sale_invoice',
    financialYear: '2025-26',
    isDeleted: false,
  };

  beforeEach(() => {
    model = {
      findOneAndUpdate: vi.fn(),
      findOne: vi.fn(),
    };
    svc = new VoucherSeriesService(model);
  });

  it('returns formatted number from existing row and does NOT self-heal', async () => {
    // First findOneAndUpdate (fast path) returns the existing doc immediately.
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(existingDoc));

    const result = await svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2025-26');

    expect(result).toBe('INV/25-26/0003');
    // Only one findOneAndUpdate call - no self-heal branch.
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    // findOne (prior lookup) is never reached.
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('pads correctly for lastUsed=1', async () => {
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain({ ...existingDoc, lastUsed: 1 }));
    expect(await svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2025-26')).toBe(
      'INV/25-26/0001',
    );
  });

  it('pads correctly for lastUsed=100 with padDigits=4', async () => {
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain({ ...existingDoc, lastUsed: 100 }));
    expect(await svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2025-26')).toBe(
      'INV/25-26/0100',
    );
  });

  it('handles custom padDigits=6', async () => {
    model.findOneAndUpdate.mockReturnValueOnce(
      makeExecChain({ ...existingDoc, padDigits: 6, lastUsed: 1 }),
    );
    expect(await svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2025-26')).toBe(
      'INV/25-26/000001',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite C: generateNextNumber -- NEW FY row (self-heal path)
// ---------------------------------------------------------------------------

describe('VoucherSeriesService.generateNextNumber -- new FY self-heal', () => {
  let model: any;
  let svc: VoucherSeriesService;

  const priorDoc = {
    prefix: 'INV',
    padDigits: 4,
    lastUsed: 99,
    workspaceId: WORKSPACE_ID,
    firmId: FIRM_ID,
    voucherType: 'sale_invoice',
    financialYear: '2025-26',
    isDeleted: false,
  };

  const upsertedDoc = {
    prefix: 'INV',
    padDigits: 4,
    lastUsed: 1,
    workspaceId: WORKSPACE_ID,
    firmId: FIRM_ID,
    voucherType: 'sale_invoice',
    financialYear: '2026-27',
    isDeleted: false,
  };

  beforeEach(() => {
    model = {
      findOneAndUpdate: vi.fn(),
      findOne: vi.fn(),
    };
    svc = new VoucherSeriesService(model);
  });

  it('creates new-FY row carrying prior prefix/padDigits and returns formatted number', async () => {
    // First findOneAndUpdate (fast path for new FY) returns null.
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(null));
    // findOne for prior series (with .sort().exec() chain).
    model.findOne.mockReturnValueOnce(makeSortExecChain(priorDoc));
    // Second findOneAndUpdate (upsert) returns the newly created doc.
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(upsertedDoc));

    const result = await svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2026-27');

    expect(result).toBe('INV/26-27/0001');

    // Fast-path call has isDeleted:false filter.
    const firstCall = model.findOneAndUpdate.mock.calls[0];
    expect(firstCall[0]).toMatchObject({
      voucherType: 'sale_invoice',
      financialYear: '2026-27',
      isDeleted: false,
    });
    expect(firstCall[1]).toMatchObject({ $inc: { lastUsed: 1 } });
    expect(firstCall[2]).toMatchObject({ new: true });

    // findOne for prior carries isDeleted:false and uses sort.
    const findOneCall = model.findOne.mock.calls[0];
    expect(findOneCall[0]).toMatchObject({ voucherType: 'sale_invoice', isDeleted: false });

    // Upsert call uses $setOnInsert with correct fields.
    const upsertCall = model.findOneAndUpdate.mock.calls[1];
    expect(upsertCall[0]).toMatchObject({ voucherType: 'sale_invoice', financialYear: '2026-27' });
    expect(upsertCall[1].$inc).toMatchObject({ lastUsed: 1 });
    expect(upsertCall[1].$setOnInsert).toMatchObject({
      prefix: 'INV',
      padDigits: 4,
      startNumber: 1,
      financialYear: '2026-27',
      isDeleted: false,
    });
    expect(upsertCall[2]).toMatchObject({ upsert: true, new: true });
  });

  it('uses DEFAULT_SERIES prefix when no prior series exists for voucherType but firm has other series', async () => {
    const anySeriesDoc = {
      prefix: 'PB',
      padDigits: 4,
      workspaceId: WORKSPACE_ID,
      firmId: FIRM_ID,
      voucherType: 'purchase_bill',
      financialYear: '2025-26',
      isDeleted: false,
    };
    const newFYDoc = {
      prefix: 'INV',
      padDigits: 4,
      lastUsed: 1,
      workspaceId: WORKSPACE_ID,
      firmId: FIRM_ID,
      voucherType: 'sale_invoice',
      financialYear: '2026-27',
      isDeleted: false,
    };

    // Fast path: null (no 2026-27 row for sale_invoice).
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(null));
    // Prior lookup for sale_invoice: null (firm never had a sale_invoice row).
    model.findOne.mockReturnValueOnce(makeSortExecChain(null));
    // Fallback: any series for firm.
    model.findOne.mockReturnValueOnce(makeExecChain(anySeriesDoc));
    // Upsert.
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(newFYDoc));

    const result = await svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2026-27');

    expect(result).toBe('INV/26-27/0001');
    const upsertCall = model.findOneAndUpdate.mock.calls[1];
    expect(upsertCall[1].$setOnInsert).toMatchObject({ prefix: 'INV', padDigits: 4 });
  });

  it('throws NotFoundException when no series at all exist for the firm', async () => {
    // Fast path: null.
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(null));
    // Prior lookup: null.
    model.findOne.mockReturnValueOnce(makeSortExecChain(null));
    // Fallback any-series: null (empty firm - seedDefaults never ran).
    model.findOne.mockReturnValueOnce(makeExecChain(null));

    await expect(
      svc.generateNextNumber(FIRM_ID_STR, 'sale_invoice', '2026-27'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fyShort is derived correctly from full FY string', async () => {
    const doc2728 = {
      prefix: 'REC',
      padDigits: 4,
      lastUsed: 5,
      workspaceId: WORKSPACE_ID,
      firmId: FIRM_ID,
    };
    model.findOneAndUpdate.mockReturnValueOnce(makeExecChain(doc2728));

    const result = await svc.generateNextNumber(FIRM_ID_STR, 'payment_in', '2027-28');
    // "2027-28".slice(2) == "27-28"
    expect(result).toBe('REC/27-28/0005');
  });
});
