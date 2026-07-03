/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';

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

/**
 * Finance/Bills hardening Pillar 1/2 — BillsService covers:
 *   - remove() is a SOFT-delete that stamps deletedBy and NEVER deletes the
 *     invoice file (BUG-FB-1 / AC-1.1 / AC-1.3 / AC-2.4).
 *   - all reads exclude isDeleted:true (AC-1.2).
 *   - update() blocks invoice replacement on a paid bill except Owner/HR
 *     (D1 / AC-1.7).
 */
function makeAudit() {
  return { logEvent: vi.fn().mockResolvedValue(undefined) };
}
function makeUploads() {
  return { deleteFile: vi.fn().mockResolvedValue(undefined) };
}

describe('BillsService — soft-delete + read exclusion + paid-invoice guard', () => {
  let uploads: ReturnType<typeof makeUploads>;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    uploads = makeUploads();
    audit = makeAudit();
  });

  it('remove() SOFT-deletes (stamps deletedBy) and NEVER deletes the invoice file', async () => {
    const updated = {
      _id: 'b1',
      type: 'payable',
      amount: 1000,
      status: 'paid',
      isDeleted: true,
    };
    const billModel: any = {
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(updated) }),
    };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    // deletedBy is cast to ObjectId — use a valid 24-char hex actor id.
    await svc.remove('ws1', 'b1', '6a2f26baca75116b4eee1c88');

    // It must call findOneAndUpdate (soft) — NOT findOneAndDelete (hard).
    expect(billModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = billModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: 'b1', workspaceId: 'ws1', isDeleted: false });
    expect(update.$set.isDeleted).toBe(true);
    expect(update.$set.deletedBy).toBeDefined();
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    // AC-1.3: the invoice file is statutory evidence — never deleted on remove.
    expect(uploads.deleteFile).not.toHaveBeenCalled();
    // Audit-trail attribution (OQ-FB-3).
    expect(audit.logEvent).toHaveBeenCalled();
  });

  it('findAll() always excludes soft-deleted bills (AC-1.2)', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const sort = vi.fn().mockReturnValue({ exec });
    const find = vi.fn().mockReturnValue({ sort });
    const billModel: any = { find };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    await svc.findAll('ws1', { type: 'payable' });

    expect(find).toHaveBeenCalledWith({ workspaceId: 'ws1', isDeleted: false, type: 'payable' });
  });

  it('findById() excludes soft-deleted bills and 404s when absent', async () => {
    const billModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    await expect(svc.findById('ws1', 'b1')).rejects.toBeInstanceOf(NotFoundException);
    expect(billModel.findOne).toHaveBeenCalledWith({
      _id: 'b1',
      workspaceId: 'ws1',
      isDeleted: false,
    });
  });

  it('update() blocks invoice replacement on a PAID bill for a non-Owner/HR (AC-1.7)', async () => {
    const current = { _id: 'b1', status: 'paid', invoiceUrl: 'old.pdf' };
    const billModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(current) }),
      findOneAndUpdate: vi.fn(),
    };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    await expect(
      svc.update('ws1', 'b1', { invoiceUrl: 'new.pdf' } as any, 'user9', false),
    ).rejects.toMatchObject({ response: { code: 'BILL_PAID_NO_DOC_REPLACE' } });
    // The block fires BEFORE any file delete or DB write.
    expect(uploads.deleteFile).not.toHaveBeenCalled();
    expect(billModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('update() ALLOWS an Owner/HR to replace a paid invoice (audited override)', async () => {
    const current = { _id: 'b1', status: 'paid', invoiceUrl: 'old.pdf' };
    const saved = { _id: 'b1', status: 'paid', invoiceUrl: 'new.pdf' };
    const billModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(current) }),
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(saved) }),
    };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    const res = await svc.update('ws1', 'b1', { invoiceUrl: 'new.pdf' } as any, 'ownerX', true);

    expect(res).toBe(saved);
    // The superseded file is released; the override is audited.
    expect(uploads.deleteFile).toHaveBeenCalledWith('old.pdf', 'ws1');
    expect(audit.logEvent).toHaveBeenCalled();
    const auditArg = audit.logEvent.mock.calls.at(-1)?.[0];
    expect(auditArg.meta.paidInvoiceOverride).toBe(true);
  });

  it('update() on a NON-throwing draft replaces the old invoice file (quota refund)', async () => {
    const current = { _id: 'b1', status: 'pending', invoiceUrl: 'old.pdf' };
    const saved = { _id: 'b1', status: 'pending', invoiceUrl: 'new.pdf' };
    const billModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(current) }),
      findOneAndUpdate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(saved) }),
    };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    await svc.update('ws1', 'b1', { invoiceUrl: 'new.pdf' } as any, 'user9', false);
    expect(uploads.deleteFile).toHaveBeenCalledWith('old.pdf', 'ws1');
  });

  it('recordPayment() flips status to paid and audits the actor', async () => {
    const bill: any = { amount: 1000, amountPaid: 0, status: 'pending', save: vi.fn() };
    bill.save.mockResolvedValue({ ...bill, amountPaid: 1000, status: 'paid' });
    const billModel: any = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(bill) }),
    };
    const svc = new BillsService(billModel, uploads as any, audit as any);

    await svc.recordPayment(
      'ws1',
      'b1',
      { amount: 1000, paymentDate: 'x', paymentMode: 'cash' } as any,
      'user9',
    );
    expect(bill.status).toBe('paid');
    expect(audit.logEvent).toHaveBeenCalled();
  });
});

// Type-only reference so a stray import of BadRequestException is exercised in
// the bundle (keeps the linter from flagging the import as unused).
void BadRequestException;
