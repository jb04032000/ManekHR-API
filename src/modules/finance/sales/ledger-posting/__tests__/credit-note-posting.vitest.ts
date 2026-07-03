/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

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
import { LedgerPostingService } from '../ledger-posting.service';

function makeService(salesReturnsSeeded = true) {
  const Model: any = vi.fn(function (this: any, data: any) {
    Object.assign(this, data);
    this.save = vi.fn(() => Promise.resolve(this));
  });
  // accountExists() - used by the #14 Sales-Returns reroute - reads this.accountModel.exists.
  const accountModel = {
    exists: vi.fn(() => Promise.resolve(salesReturnsSeeded ? { _id: new Types.ObjectId() } : null)),
  };
  const accountsService = {
    findByCode: vi.fn((_ws: string, _firm: string, code: string) =>
      Promise.resolve({ _id: new Types.ObjectId(), name: `Account ${code}`, code }),
    ),
  };
  return { svc: new LedgerPostingService(Model, accountModel as any, accountsService as any) };
}

function cn(extra: any) {
  return {
    _id: new Types.ObjectId(),
    financialYear: '2026-27',
    voucherDate: new Date('2026-04-10'),
    voucherNumber: 'CN-1',
    sourceInvoiceNumber: 'INV-1',
    partyId: new Types.ObjectId(),
    narration: undefined,
    ...extra,
  };
}
const opts = () => ({
  userId: new Types.ObjectId().toString(),
  firm: { _id: new Types.ObjectId(), workspaceId: new Types.ObjectId() },
});
const sum = (lines: any[], k: 'debit' | 'credit') => lines.reduce((s, l) => s + l[k], 0);

describe('postCreditNote - commercial (kasar-vatav) vs regular', () => {
  it('commercial CN: Dr 5026 Kasar-Vatav Allowed, Cr Debtors, no Sales/GST, balanced', async () => {
    const { svc } = makeService();
    const entry: any = await svc.postCreditNote(
      cn({
        isCommercial: true,
        isIntraState: true,
        taxableValuePaise: 50000,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        grandTotalPaise: 50000,
      }),
      100000, // amount due > grandTotal -> full debtor reduction
      opts(),
    );
    const codes = entry.lines.map((l: any) => l.accountCode);
    expect(codes).toContain('5026');
    expect(codes).toContain('1003');
    expect(codes).not.toContain('4001'); // no Sales reversal
    expect(codes).not.toContain('2007'); // no CGST reversal
    expect(entry.lines.find((l: any) => l.accountCode === '5026').debit).toBe(50000);
    expect(entry.lines.find((l: any) => l.accountCode === '1003').credit).toBe(50000);
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('regular CN still reverses Sales + GST', async () => {
    const { svc } = makeService();
    const entry: any = await svc.postCreditNote(
      cn({
        isCommercial: false,
        isIntraState: true,
        taxableValuePaise: 50000,
        cgstPaise: 2500,
        sgstPaise: 2500,
        igstPaise: 0,
        grandTotalPaise: 55000,
      }),
      100000,
      opts(),
    );
    const codes = entry.lines.map((l: any) => l.accountCode);
    expect(codes).toContain('4009'); // #14: Sales Returns contra-revenue (not 4001 directly)
    expect(codes).not.toContain('4001');
    expect(codes).toContain('2007'); // CGST
    expect(codes).toContain('2008'); // SGST
    expect(codes).not.toContain('5026');
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('regular CN falls back to Sales 4001 when the Sales Returns account is not seeded', async () => {
    const { svc } = makeService(false); // 4009 absent (firm predates the seed)
    const entry: any = await svc.postCreditNote(
      cn({
        isCommercial: false,
        isIntraState: true,
        taxableValuePaise: 50000,
        cgstPaise: 2500,
        sgstPaise: 2500,
        igstPaise: 0,
        grandTotalPaise: 55000,
      }),
      100000,
      opts(),
    );
    const codes = entry.lines.map((l: any) => l.accountCode);
    expect(codes).toContain('4001'); // fell back to Sales
    expect(codes).not.toContain('4009');
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });
});
