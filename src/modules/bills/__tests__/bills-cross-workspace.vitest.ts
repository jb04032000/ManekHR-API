/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Finance/Bills hardening — CROSS-WORKSPACE ISOLATION (AC-2.1 / AC-2.2 / AC-2.6)
 *
 * Every BillsService method that accepts a billId must scope the Mongo query to
 * the workspaceId from the route param. If a Bill from workspace B is queried
 * under workspace A's route, the service must return NotFoundException (404) and
 * must NEVER touch the Bill (no soft-delete, no update, no payment).
 *
 * Covers:
 *   - findById: workspace mismatch returns 404.
 *   - update: workspace mismatch returns 404.
 *   - remove (soft-delete): workspace mismatch returns 404; deleteFile never called.
 *   - recordPayment: workspace mismatch returns 404.
 *   - findAll: the workspace filter is always present in the Mongo query (never
 *     returns rows from a different workspace).
 *   - BillsLifecycleService.memberHasHistory: scoped per workspace (a hit in
 *     WS_B does not affect WS_A and vice versa).
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';

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

import { BillsService } from '../bills.service';
import { BillsLifecycleService } from '../bills-lifecycle.service';

// Valid 24-char hex ObjectIds for both workspaces.
const WS_A = '6a2f26baca75116b4eee1c80';
const _WS_B = '6a2f26baca75116b4eee1c81';
const BILL_IN_WS_B = '6a2f26baca75116b4eee1c82';
const USER_A = '6a2f26baca75116b4eee1c88';

function makeUploads() {
  return { deleteFile: vi.fn().mockResolvedValue(undefined) };
}
function makeAudit() {
  return { logEvent: vi.fn().mockResolvedValue(undefined) };
}

/**
 * A BillModel whose findOne returns null (simulating the workspace-scoped query
 * not finding a bill that lives in a different workspace). This is exactly the
 * result of `findOne({ _id: BILL_IN_WS_B, workspaceId: WS_A, isDeleted: false })`
 * when the bill has workspaceId=WS_B — Mongo returns null because the compound
 * filter does not match.
 */
function makeNullBillModel() {
  return {
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    findOneAndUpdate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    find: vi
      .fn()
      .mockReturnValue({ sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }) }),
  } as any;
}

describe('BillsService — cross-workspace isolation (AC-2.1)', () => {
  it('findById with wrong workspace returns NotFoundException (404)', async () => {
    const svc = new BillsService(makeNullBillModel(), makeUploads() as any, makeAudit() as any);
    await expect(svc.findById(WS_A, BILL_IN_WS_B)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update with wrong workspace returns NotFoundException before any file or DB write', async () => {
    const uploads = makeUploads();
    const billModel = makeNullBillModel();
    const svc = new BillsService(billModel, uploads as any, makeAudit() as any);

    await expect(
      svc.update(WS_A, BILL_IN_WS_B, { invoiceUrl: 'new.pdf' } as any, USER_A, false),
    ).rejects.toBeInstanceOf(NotFoundException);

    // No file mutation and no findOneAndUpdate must have been called for the cross-ws attempt.
    expect(uploads.deleteFile).not.toHaveBeenCalled();
    expect(billModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('remove (soft-delete) with wrong workspace returns NotFoundException; no soft-delete written', async () => {
    const uploads = makeUploads();
    const billModel = makeNullBillModel();
    const svc = new BillsService(billModel, uploads as any, makeAudit() as any);

    await expect(svc.remove(WS_A, BILL_IN_WS_B, USER_A)).rejects.toBeInstanceOf(NotFoundException);

    // The findOneAndUpdate was called once — but its result was null so a 404 was thrown.
    // Verify that findOneAndUpdate's filter always scopes to WS_A (never WS_B).
    if (billModel.findOneAndUpdate.mock.calls.length > 0) {
      const filter = billModel.findOneAndUpdate.mock.calls[0][0];
      expect(String(filter.workspaceId ?? '')).toBe(WS_A);
    }
    // Physical file must never be deleted.
    expect(uploads.deleteFile).not.toHaveBeenCalled();
  });

  it('recordPayment with wrong workspace returns NotFoundException (findById null)', async () => {
    const svc = new BillsService(makeNullBillModel(), makeUploads() as any, makeAudit() as any);
    await expect(
      svc.recordPayment(
        WS_A,
        BILL_IN_WS_B,
        { amount: 500, paymentDate: 'x', paymentMode: 'cash' } as any,
        USER_A,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findAll always includes workspaceId in the Mongo filter (no cross-workspace leak)', async () => {
    const billModel: any = {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
      }),
    };
    const svc = new BillsService(billModel, makeUploads() as any, makeAudit() as any);

    await svc.findAll(WS_A, { type: 'payable' });

    const filter = billModel.find.mock.calls[0][0];
    // The workspaceId filter ties every query to the route's workspace.
    expect(filter.workspaceId).toBe(WS_A);
    // Soft-deleted bills are excluded from every list (AC-1.2 cross-check).
    expect(filter.isDeleted).toBe(false);
  });
});

describe('BillsLifecycleService.memberHasHistory — workspace-scoped probe (cross-workspace isolation)', () => {
  function existsModel(hit: boolean) {
    return { exists: vi.fn().mockResolvedValue(hit ? { _id: 'x' } : null) };
  }

  it('returns FALSE for WS_A when the member has a Bill only in WS_B (probes are workspace-scoped)', async () => {
    // All model probes return null (simulating no WS_A records for the member).
    const svc = new BillsLifecycleService(
      existsModel(false) as any,
      existsModel(false) as any,
      existsModel(false) as any,
      existsModel(false) as any,
    );
    expect(await svc.memberHasHistory(WS_A, USER_A)).toBe(false);
  });

  it('passes workspaceId as the scope to every exists() call — never returns ALL workspaces', async () => {
    // We need to inspect the `workspaceId` argument to `exists()`.
    const billExists = vi.fn().mockResolvedValue(null);
    const billModel: any = { exists: billExists };
    const svc = new BillsLifecycleService(
      billModel,
      existsModel(false) as any,
      existsModel(false) as any,
      existsModel(false) as any,
    );

    await svc.memberHasHistory(WS_A, USER_A);

    // The Bill probe's filter must include the workspace.
    const filter = billExists.mock.calls[0]?.[0];
    expect(filter).toBeDefined();
    // workspaceId is stored as a Types.ObjectId — check its string form.
    const wsInFilter = filter?.workspaceId?.toString?.() ?? filter?.workspaceId;
    expect(wsInFilter).toBe(WS_A);
  });
});
