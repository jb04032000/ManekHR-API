/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing LedgerPostingService so the
// transitive schema imports (Account, LedgerEntry) don't trip the "Cannot
// determine type" reflection error under vitest. Models are injected as mocks.
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

// Unit-tests postOpeningBalance line-building: the account gets the chosen side,
// 3004 Opening Balance Equity takes the opposite, and the batch is balanced.
// Model + AccountsService are mocked (no Nest/Mongo); we assert the captured entry.

function makeModel() {
  const Model: any = vi.fn(function (this: any, data: any) {
    Object.assign(this, data);
    this.save = vi.fn(() => Promise.resolve(this));
  });
  // No existing opening-balance entry by default.
  Model.findOne = vi.fn(() => ({ session: () => Promise.resolve(null) }));
  Model.deleteOne = vi.fn(() => Promise.resolve({ deletedCount: 1 }));
  return Model;
}

function makeAccountsService() {
  return {
    findByCode: vi.fn((_ws: string, _firm: string, code: string) =>
      Promise.resolve({ _id: new Types.ObjectId(), code, name: `Account ${code}` }),
    ),
  };
}

function makeService() {
  const model = makeModel();
  const accountsService = makeAccountsService();
  const svc = new LedgerPostingService(model, {} as any, accountsService as any);
  return { svc, model, accountsService };
}

const account = { _id: new Types.ObjectId(), code: '1003', name: 'Sundry Debtors' };
const baseParams = {
  workspaceId: new Types.ObjectId(),
  firmId: new Types.ObjectId(),
  asOfDate: new Date('2026-04-01'),
  financialYear: '2026-27',
};
const opts = { userId: new Types.ObjectId().toString() };

describe('LedgerPostingService.postOpeningBalance', () => {
  let s: ReturnType<typeof makeService>;
  beforeEach(() => {
    s = makeService();
  });

  it('debit opening balance: Dr account, Cr 3004, balanced', async () => {
    const entry: any = await s.svc.postOpeningBalance(
      account,
      { ...baseParams, amountPaise: 500000, drOrCr: 'debit' },
      opts,
    );
    expect(entry).not.toBeNull();
    expect(entry.entryType).toBe('opening_balance');
    expect(entry.sourceVoucherType).toBe('opening_balance');
    expect(entry.lines).toHaveLength(2);

    const acctLine = entry.lines.find((l: any) => l.accountCode === '1003');
    const equityLine = entry.lines.find((l: any) => l.accountCode === '3004');
    expect(acctLine.debit).toBe(500000);
    expect(acctLine.credit).toBe(0);
    expect(equityLine.credit).toBe(500000);
    expect(equityLine.debit).toBe(0);

    const totalDr = entry.lines.reduce((n: number, l: any) => n + l.debit, 0);
    const totalCr = entry.lines.reduce((n: number, l: any) => n + l.credit, 0);
    expect(totalDr).toBe(totalCr);
  });

  it('credit opening balance: Cr account, Dr 3004, balanced', async () => {
    const entry: any = await s.svc.postOpeningBalance(
      { _id: new Types.ObjectId(), code: '2001', name: 'Sundry Creditors' },
      { ...baseParams, amountPaise: 300000, drOrCr: 'credit' },
      opts,
    );
    const acctLine = entry.lines.find((l: any) => l.accountCode === '2001');
    const equityLine = entry.lines.find((l: any) => l.accountCode === '3004');
    expect(acctLine.credit).toBe(300000);
    expect(equityLine.debit).toBe(300000);
    expect(entry.lines.reduce((n: number, l: any) => n + l.debit, 0)).toBe(
      entry.lines.reduce((n: number, l: any) => n + l.credit, 0),
    );
  });

  it('zero amount clears: returns null and posts nothing', async () => {
    const entry = await s.svc.postOpeningBalance(
      account,
      { ...baseParams, amountPaise: 0, drOrCr: 'debit' },
      opts,
    );
    expect(entry).toBeNull();
    // No new entry constructed (the model constructor was never called as a ctor).
    expect(s.model.mock.instances.length).toBe(0);
  });

  it('P0: clearing an existing entry marks it reversed (no hard delete)', async () => {
    const existing: any = {
      _id: new Types.ObjectId(),
      isReversed: false,
      auditLog: [],
      save: vi.fn(function (this: any) {
        return Promise.resolve(this);
      }),
    };
    s.model.findOne = vi.fn(() => ({ session: () => Promise.resolve(existing) }));
    const entry = await s.svc.postOpeningBalance(
      account,
      { ...baseParams, amountPaise: 0, drOrCr: 'debit' },
      opts,
    );
    expect(entry).toBeNull();
    expect(existing.isReversed).toBe(true); // reversed, not deleted
    expect(existing.save).toHaveBeenCalledTimes(1);
    expect(existing.auditLog).toHaveLength(1);
    expect(s.model.deleteOne).not.toHaveBeenCalled(); // never hard-deletes
  });
});
