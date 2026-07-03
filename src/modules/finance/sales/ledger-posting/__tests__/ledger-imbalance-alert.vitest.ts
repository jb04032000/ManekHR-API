/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators (transitive schema imports) + capture Sentry so we can
// assert the D23 alert fires. See auth.service.audit.vitest.ts for the decorator-mock pattern.
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

const captureException = vi.fn();
vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import { Types } from 'mongoose';
import { LedgerPostingService } from '../ledger-posting.service';

const opts = () =>
  ({
    firm: { _id: new Types.ObjectId(), workspaceId: new Types.ObjectId() },
    userId: new Types.ObjectId().toString(),
  }) as any;

const jv = (debit: number, credit: number) =>
  ({
    _id: new Types.ObjectId(),
    voucherType: 'journal',
    voucherDate: new Date('2026-04-01'),
    financialYear: '2026-27',
    voucherNumber: 'JV-1',
    narration: 'test',
    lines: [
      {
        accountId: new Types.ObjectId(),
        accountCode: '1001',
        accountName: 'Cash',
        debitPaise: debit,
        creditPaise: 0,
      },
      {
        accountId: new Types.ObjectId(),
        accountCode: '4001',
        accountName: 'Sales',
        debitPaise: 0,
        creditPaise: credit,
      },
    ],
  }) as any;

// D23: an imbalanced posting batch must alert ops (Sentry) AND fail - never pass silently.
describe('LedgerPostingService imbalance alerting (D23)', () => {
  beforeEach(() => captureException.mockClear());

  it('alerts + throws when a posted batch does not balance', async () => {
    const svc = new LedgerPostingService({} as any, {} as any, {} as any);
    await expect(svc.postJournalVoucher(jv(100000, 90000), opts())).rejects.toThrow(/imbalance/i);

    expect(captureException).toHaveBeenCalledTimes(1);
    const ctx = captureException.mock.calls[0][1];
    expect(ctx.tags.op).toBe('ledger_posting_imbalance');
    expect(ctx.extra.delta).toBe(10000);
  });

  it('does not alert when the batch balances', async () => {
    const Model: any = vi.fn(function (this: any, data: any) {
      Object.assign(this, data);
      this.save = vi.fn(() => Promise.resolve(this));
    });
    const svc = new LedgerPostingService(Model, {} as any, {} as any);
    await svc.postJournalVoucher(jv(100000, 100000), opts());
    expect(captureException).not.toHaveBeenCalled();
  });
});
