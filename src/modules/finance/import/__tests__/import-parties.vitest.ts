/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose so the transitive schema imports don't trip reflect-metadata.
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

import { ImportService } from '../import.service';

function makeService(
  existingParties: { name: string; gstin?: string; _id?: string }[] = [],
  accountList: { code: string; name: string; _id: string }[] = [],
  itemList: { name: string }[] = [],
  existingBills: { partyId: string; voucherNumber: string }[] = [],
) {
  const parties: any = {
    findAll: vi.fn(() =>
      Promise.resolve({ items: existingParties, total: existingParties.length }),
    ),
    create: vi.fn((_ws: string, _firm: string, dto: any) => Promise.resolve({ _id: 'x', ...dto })),
  };
  const accounts: any = {
    findAll: vi.fn(() => Promise.resolve(accountList)),
    findByCode: vi.fn((_w: string, _f: string, code: string) =>
      Promise.resolve({ _id: `acc-${code}`, name: `Account ${code}`, code }),
    ),
  };
  const openingBalance: any = { setOpeningBalance: vi.fn(() => Promise.resolve({})) };
  const items: any = {
    findAll: vi.fn(() => Promise.resolve(itemList)),
    create: vi.fn((_ws: string, _firm: string, dto: any) => Promise.resolve({ _id: 'i', ...dto })),
  };
  const ledgerPosting: any = { postManualJournal: vi.fn(() => Promise.resolve({ _id: 'le-1' })) };
  // R9: FyLockService - pending-invoice/opening-balance commits assert the period lock. Default
  // mock resolves (period open); tests that need a locked period override assertOpen.
  const fyLock: any = { assertOpen: vi.fn(() => Promise.resolve()) };
  const openingInvoice: any = {
    find: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve(existingBills) }) })),
    create: vi.fn(() => Promise.resolve({})),
  };
  return {
    svc: new ImportService(
      parties,
      accounts,
      openingBalance,
      items,
      ledgerPosting,
      fyLock,
      openingInvoice,
    ),
    parties,
    accounts,
    openingBalance,
    items,
    ledgerPosting,
    fyLock,
    openingInvoice,
  };
}

describe('ImportService.validateParties (D19 dry-run)', () => {
  it('classifies valid / error / in-file-dup / in-db-dup rows', async () => {
    const { svc } = makeService([{ name: 'Acme' }]); // existing party in the DB
    const dry = await svc.validateParties('w', 'f', [
      { name: 'New Co', partyType: 'customer' }, // valid
      { name: '', partyType: 'customer' }, // error: no name
      { name: 'Bad', partyType: 'alien' }, // error: bad type
      { name: 'Acme' }, // duplicate (already in DB)
      { name: 'New Co', partyType: 'customer' }, // duplicate (earlier row in file)
    ]);
    expect(dry.summary).toEqual({ total: 5, valid: 1, errors: 2, duplicates: 2 });
    expect(dry.rows[0].status).toBe('valid');
    expect(dry.rows[0].party?.name).toBe('New Co');
    expect(dry.rows[3].status).toBe('duplicate');
  });

  it('rejects an invalid GSTIN', async () => {
    const { svc } = makeService();
    const dry = await svc.validateParties('w', 'f', [{ name: 'X', gstin: 'NOTAGSTIN' }]);
    expect(dry.rows[0].status).toBe('error');
  });

  it('commit creates only the valid rows', async () => {
    const { svc, parties } = makeService();
    const res = await svc.commitParties('w', 'f', [
      { name: 'A', partyType: 'customer' },
      { name: '', partyType: 'customer' }, // error -> skipped
    ]);
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(parties.create).toHaveBeenCalledTimes(1);
  });
});

describe('ImportService.validateOpeningBalances (D19 dry-run)', () => {
  const accts = [
    { code: '1003', name: 'Sundry Debtors', _id: 'a1' },
    { code: '2001', name: 'Sundry Creditors', _id: 'a2' },
  ];

  it('classifies valid / unknown-account / bad-amount / duplicate', async () => {
    const { svc } = makeService([], accts);
    const dry = await svc.validateOpeningBalances('w', 'f', [
      { accountCode: '1003', amount: '500', drOrCr: 'debit', asOfDate: '2026-04-01' }, // valid
      { accountCode: '9999', amount: '100', drOrCr: 'debit', asOfDate: '2026-04-01' }, // unknown account
      { accountCode: '2001', amount: '0', drOrCr: 'credit', asOfDate: '2026-04-01' }, // bad amount
      { accountCode: '1003', amount: '200', drOrCr: 'debit', asOfDate: '2026-04-01' }, // duplicate
    ]);
    // R9: summary now carries the net plug to 3004 Opening Balance Equity. The only valid row is a
    // 500.00 debit -> +50000 paise.
    expect(dry.summary).toEqual({
      total: 4,
      valid: 1,
      errors: 2,
      duplicates: 1,
      netToOpeningEquityPaise: 50000,
    });
    expect(dry.rows[0].ob?.amountPaise).toBe(50000);
    expect(dry.rows[0].ob?.drOrCr).toBe('debit');
  });

  it('errors on a missing / invalid as-of date', async () => {
    const { svc } = makeService([], accts);
    const dry = await svc.validateOpeningBalances('w', 'f', [
      { accountCode: '1003', amount: '500', drOrCr: 'debit', asOfDate: '' },
    ]);
    expect(dry.rows[0].status).toBe('error');
  });

  it('commit posts only the valid rows through setOpeningBalance', async () => {
    const { svc, openingBalance } = makeService([], accts);
    const res = await svc.commitOpeningBalances(
      'w',
      'f',
      [
        { accountCode: '1003', amount: '500', drOrCr: 'debit', asOfDate: '2026-04-01' },
        { accountCode: 'nope', amount: '1', drOrCr: 'debit', asOfDate: '2026-04-01' }, // error
      ],
      'user1',
    );
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(openingBalance.setOpeningBalance).toHaveBeenCalledTimes(1);
  });
});

describe('ImportService.validateItems (D19 dry-run)', () => {
  it('classifies valid / bad-type / bad-hsn / bad-gst / duplicate', async () => {
    const { svc } = makeService([], [], [{ name: 'Existing Item' }]);
    const dry = await svc.validateItems('w', 'f', [
      { name: 'Cotton Fabric', itemType: 'goods', unit: 'MTR', hsnSacCode: '5208', gstRate: '5' }, // valid
      { name: 'Bad', itemType: 'widget' }, // error: bad type
      { name: 'BadHsn', hsnSacCode: 'XX' }, // error: bad hsn
      { name: 'BadGst', gstRate: '7' }, // error: bad gst slab
      { name: 'Existing Item' }, // duplicate (already in DB)
      { name: 'Cotton Fabric' }, // duplicate (earlier row in file)
    ]);
    expect(dry.summary).toEqual({ total: 6, valid: 1, errors: 3, duplicates: 2 });
    expect(dry.rows[0].item?.unit).toBe('MTR');
    expect(dry.rows[0].item?.gstRate).toBe(5);
  });

  it('commit creates only the valid items', async () => {
    const { svc, items } = makeService();
    const res = await svc.commitItems('w', 'f', [
      { name: 'A', itemType: 'goods' },
      { name: 'B', itemType: 'widget' }, // error -> skipped
    ]);
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(items.create).toHaveBeenCalledTimes(1);
  });
});

describe('ImportService.validatePendingInvoices (D19 dry-run)', () => {
  // validatePendingInvoices builds an ObjectId from ws/firm (route params are real ObjectIds).
  const WS = '507f1f77bcf86cd799439011';
  const FIRM = '507f1f77bcf86cd799439012';

  it('classifies valid / unknown-party / bad-amount / duplicate', async () => {
    const { svc } = makeService([{ name: 'Acme Mills' }]);
    const dry = await svc.validatePendingInvoices(WS, FIRM, [
      { party: 'Acme Mills', voucherNumber: 'INV-1', voucherDate: '2026-03-01', amount: '5000' }, // valid
      { party: 'Ghost Co', voucherNumber: 'INV-2', voucherDate: '2026-03-01', amount: '100' }, // unknown party
      { party: 'Acme Mills', voucherNumber: 'INV-3', voucherDate: '2026-03-01', amount: '0' }, // bad amount
      { party: 'Acme Mills', voucherNumber: 'INV-1', voucherDate: '2026-03-01', amount: '200' }, // duplicate
    ]);
    expect(dry.summary).toEqual({ total: 4, valid: 1, errors: 2, duplicates: 1 });
    expect(dry.rows[0].bill?.amountPaise).toBe(500000);
  });

  it('commit posts each valid bill (Dr Debtors / Cr 3004) and stores it', async () => {
    const { svc, ledgerPosting, openingInvoice } = makeService([
      { name: 'Acme Mills', _id: '507f1f77bcf86cd799439011' },
    ]);
    const res = await svc.commitPendingInvoices(
      WS,
      FIRM,
      [
        { party: 'Acme Mills', voucherNumber: 'INV-1', voucherDate: '2026-03-01', amount: '5000' },
        { party: 'Nobody', voucherNumber: 'INV-2', voucherDate: '2026-03-01', amount: '1' }, // error
      ],
      'user1',
    );
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(ledgerPosting.postManualJournal).toHaveBeenCalledTimes(1);
    expect(openingInvoice.create).toHaveBeenCalledTimes(1);
  });

  it('R9: a bill dated in a locked period is recorded as failed, not posted, and the batch survives', async () => {
    const { svc, fyLock, ledgerPosting, openingInvoice } = makeService([
      { name: 'Acme Mills', _id: '507f1f77bcf86cd799439011' },
    ]);
    // The period lock rejects the (single valid) bill's date.
    fyLock.assertOpen.mockRejectedValueOnce(new Error('Books are locked up to 2026-03-31'));
    const res = await svc.commitPendingInvoices(
      WS,
      FIRM,
      [{ party: 'Acme Mills', voucherNumber: 'INV-1', voucherDate: '2026-03-01', amount: '5000' }],
      'user1',
    );
    expect(res.created).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toMatch(/locked/i);
    // The guard fired before any ledger / tracking write.
    expect(ledgerPosting.postManualJournal).not.toHaveBeenCalled();
    expect(openingInvoice.create).not.toHaveBeenCalled();
  });
});
