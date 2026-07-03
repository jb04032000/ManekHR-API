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

// accountExistsResult drives the 4021/4024 fallback: true = textile firm (has them),
// false = non-textile firm (only 4020 seeded -> everything falls back to 4020).
function makeService(accountExistsResult: boolean) {
  const Model: any = vi.fn(function (this: any, data: any) {
    Object.assign(this, data);
    this.save = vi.fn(() => Promise.resolve(this));
  });
  const accountModel = {
    exists: vi.fn(() =>
      Promise.resolve(accountExistsResult ? { _id: new Types.ObjectId() } : null),
    ),
  };
  const accountsService = {
    findByCode: vi.fn((_w: string, _f: string, code: string) =>
      Promise.resolve({ _id: new Types.ObjectId(), name: `Account ${code}`, code }),
    ),
  };
  return { svc: new LedgerPostingService(Model, accountModel as any, accountsService as any) };
}

const invoice = (incomeLines?: any[]) => ({
  _id: new Types.ObjectId(),
  workspaceId: new Types.ObjectId(),
  firmId: new Types.ObjectId(),
  financialYear: '2026-27',
  voucherDate: new Date('2026-04-10'),
  voucherNumber: 'JW-1',
  partyId: new Types.ObjectId(),
  totalPaise: 63000,
  subTotalPaise: 60000,
  cgstPaise: 1500,
  sgstPaise: 1500,
  igstPaise: 0,
  incomeLines,
});
const opts = { userId: new Types.ObjectId().toString() };
const creditFor = (entry: any, code: string) =>
  entry.lines
    .filter((l: any) => l.accountCode === code)
    .reduce((s: number, l: any) => s + l.credit, 0);
const sum = (lines: any[], k: 'debit' | 'credit') => lines.reduce((s, l) => s + l[k], 0);

const mixedLines = [
  { jobWorkType: 'dyeing_printing', amountPaise: 30000 },
  { jobWorkType: 'general_textile', amountPaise: 20000 },
  { jobWorkType: 'other', amountPaise: 10000 },
];

describe('postJobWorkInvoice income split (D13/§4)', () => {
  it('textile firm: splits income to 4021 / 4020 / 4024, balanced', async () => {
    const { svc } = makeService(true);
    const entry: any = await svc.postJobWorkInvoice(invoice(mixedLines) as any, true, opts);
    expect(creditFor(entry, '4021')).toBe(30000); // dyeing/printing
    expect(creditFor(entry, '4020')).toBe(20000); // general
    expect(creditFor(entry, '4024')).toBe(10000); // other
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('R5: printing -> 4022 and embroidery -> 4023 route to their own ledgers, balanced', async () => {
    const { svc } = makeService(true);
    const lines = [
      { jobWorkType: 'printing', amountPaise: 25000 },
      { jobWorkType: 'embroidery', amountPaise: 20000 },
      { jobWorkType: 'dyeing_printing', amountPaise: 15000 }, // legacy stays on 4021
    ];
    const inv = { ...invoice(lines), subTotalPaise: 60000, totalPaise: 63000 };
    const entry: any = await svc.postJobWorkInvoice(inv as any, true, opts);
    expect(creditFor(entry, '4022')).toBe(25000); // printing
    expect(creditFor(entry, '4023')).toBe(20000); // embroidery
    expect(creditFor(entry, '4021')).toBe(15000); // legacy dyeing_printing
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('non-textile firm: process ledgers absent -> all income falls back to 4020', async () => {
    const { svc } = makeService(false);
    const entry: any = await svc.postJobWorkInvoice(invoice(mixedLines) as any, true, opts);
    expect(creditFor(entry, '4020')).toBe(60000);
    expect(creditFor(entry, '4021')).toBe(0);
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('no line breakdown -> whole subtotal posts to 4020 (back-compat)', async () => {
    const { svc } = makeService(true);
    const entry: any = await svc.postJobWorkInvoice(invoice(undefined) as any, true, opts);
    expect(creditFor(entry, '4020')).toBe(60000);
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });
});
