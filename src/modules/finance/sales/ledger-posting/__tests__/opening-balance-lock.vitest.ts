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

import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { OpeningBalanceService } from '../opening-balance.service';

// P0: setOpeningBalance posts an authoritative ledger entry, so it must honour the period lock /
// closed FY (FyLockService.assertOpen) - it bypassed this before.
describe('OpeningBalanceService period-lock enforcement', () => {
  it('refuses to set an opening balance dated in a locked period and posts nothing', async () => {
    const account = {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(),
      firmId: new Types.ObjectId(),
      code: '1003',
      name: 'Debtors',
    };
    const accountModel: any = { findOne: vi.fn(() => Promise.resolve(account)) };
    const ledgerPosting: any = { postOpeningBalance: vi.fn(() => Promise.resolve(null)) };
    const auditService: any = { logEvent: vi.fn(() => Promise.resolve()) };
    const fyLock: any = {
      assertOpen: vi.fn(() =>
        Promise.reject(new BadRequestException('Books are locked up to ...')),
      ),
    };
    const svc = new OpeningBalanceService(accountModel, ledgerPosting, auditService, fyLock);

    await expect(
      svc.setOpeningBalance(
        account.workspaceId.toString(),
        account.firmId.toString(),
        account._id.toString(),
        { amountPaise: 500000, drOrCr: 'debit', asOfDate: '2026-04-01' } as any,
        new Types.ObjectId().toString(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fyLock.assertOpen).toHaveBeenCalledTimes(1);
    expect(ledgerPosting.postOpeningBalance).not.toHaveBeenCalled(); // blocked before any write
  });
});
