/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

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

import { BillsLifecycleService } from '../bills-lifecycle.service';

/**
 * Finance/Bills hardening Pillar 1 — BillsLifecycleService.memberHasHistory:
 *   - TRUE on ANY Bill / PurchaseBill / ExpenseVoucher / LedgerEntry attributed
 *     to the member (OQ-FB-1 → A: draft-only counts; AC-1.5).
 *   - FALSE only when ALL four probes miss.
 *   - short-circuits on the first hit.
 */
function existsModel(hit: boolean) {
  return { exists: vi.fn().mockResolvedValue(hit ? { _id: 'x' } : null) };
}

function makeService(hits: { bill?: boolean; pb?: boolean; ev?: boolean; le?: boolean } = {}) {
  const bill = existsModel(!!hits.bill);
  const pb = existsModel(!!hits.pb);
  const ev = existsModel(!!hits.ev);
  const le = existsModel(!!hits.le);
  const svc = new BillsLifecycleService(bill as any, pb as any, ev as any, le as any);
  return { svc, bill, pb, ev, le };
}

const WS = '6a2f26baca75116b4eee1c86';
const MEMBER = '6a2f26baca75116b4eee1c88';

describe('BillsLifecycleService.memberHasHistory (OQ-FB-1 → A)', () => {
  it('returns FALSE when the member has no finance/bills records', async () => {
    const { svc } = makeService();
    expect(await svc.memberHasHistory(WS, MEMBER)).toBe(false);
  });

  it('returns TRUE on a legacy Bill (incl. draft/never-paid) and short-circuits', async () => {
    const { svc, bill, pb, ev, le } = makeService({ bill: true });
    expect(await svc.memberHasHistory(WS, MEMBER)).toBe(true);
    expect(bill.exists).toHaveBeenCalledTimes(1);
    // Short-circuit: later probes are never reached.
    expect(pb.exists).not.toHaveBeenCalled();
    expect(ev.exists).not.toHaveBeenCalled();
    expect(le.exists).not.toHaveBeenCalled();
  });

  it('returns TRUE on a PurchaseBill the member posted OR created (auditLog[0].by)', async () => {
    const { svc, pb } = makeService({ pb: true });
    expect(await svc.memberHasHistory(WS, MEMBER)).toBe(true);
    // The probe ORs postedBy with the first auditLog entry (the creator).
    const filter = pb.exists.mock.calls[0][0];
    expect(filter.$or).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ postedBy: expect.anything() }),
        expect.objectContaining({ 'auditLog.0.by': expect.anything() }),
      ]),
    );
  });

  it('returns TRUE on an ExpenseVoucher created by the member', async () => {
    const { svc } = makeService({ ev: true });
    expect(await svc.memberHasHistory(WS, MEMBER)).toBe(true);
  });

  it('returns TRUE on a LedgerEntry posted by the member', async () => {
    const { svc } = makeService({ le: true });
    expect(await svc.memberHasHistory(WS, MEMBER)).toBe(true);
  });
});
