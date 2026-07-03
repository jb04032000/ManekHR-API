/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators so the schema imports don't trip reflect-metadata under vitest.
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

// postManualJournal is the central path for callers without a JournalVoucher (e.g. the late-fee
// cron). It must enforce the zero-sum invariant and build a standard journal LedgerEntry.
function makeModel() {
  const Model: any = vi.fn(function (this: any, data: any) {
    Object.assign(this, data);
    this.save = vi.fn(() => Promise.resolve(this));
  });
  return Model;
}

const baseParams = {
  workspaceId: new Types.ObjectId(),
  firmId: new Types.ObjectId(),
  financialYear: '2026-27',
  entryDate: new Date('2026-05-01'),
  sourceVoucherId: new Types.ObjectId(),
  sourceVoucherType: 'late_fee_accrual',
  sourceVoucherNumber: 'LF-123',
  narration: 'Late fee accrued',
};
const opts = { userId: new Types.ObjectId().toHexString() };
const acc = () => new Types.ObjectId();

describe('LedgerPostingService.postManualJournal', () => {
  it('builds a balanced journal entry and saves it', async () => {
    const model = makeModel();
    const svc = new LedgerPostingService(model, {} as any, {} as any);
    const entry: any = await svc.postManualJournal(
      {
        ...baseParams,
        lines: [
          { accountId: acc(), accountCode: '1003', accountName: 'Debtors', debit: 1000, credit: 0 },
          {
            accountId: acc(),
            accountCode: '4006',
            accountName: 'Late Fee',
            debit: 0,
            credit: 1000,
          },
        ],
      },
      opts,
    );
    expect(entry.entryType).toBe('journal');
    expect(entry.sourceVoucherType).toBe('late_fee_accrual');
    expect(entry.lines).toHaveLength(2);
    expect(entry.isReversed).toBe(false);
    expect(entry.save).toHaveBeenCalledTimes(1);
  });

  it('rejects an unbalanced entry (zero-sum invariant)', async () => {
    const model = makeModel();
    const svc = new LedgerPostingService(model, {} as any, {} as any);
    await expect(
      svc.postManualJournal(
        {
          ...baseParams,
          lines: [
            {
              accountId: acc(),
              accountCode: '1003',
              accountName: 'Debtors',
              debit: 1000,
              credit: 0,
            },
            {
              accountId: acc(),
              accountCode: '4006',
              accountName: 'Late Fee',
              debit: 0,
              credit: 900,
            },
          ],
        },
        opts,
      ),
    ).rejects.toThrow();
    expect(model.mock.instances.length).toBe(0); // never constructed an entry
  });
});
