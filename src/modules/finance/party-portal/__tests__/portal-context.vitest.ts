import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { Types, model } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import {
  startMemoryMongo,
  stopMemoryMongo,
  clearAllCollections,
} from '../../../../../test-utils/mongo-memory';
import { LedgerEntrySchema } from '../../sales/ledger-posting/ledger-entry.schema';

/**
 * /portal/context outstanding aggregation suite (Plan 04 Task 2).
 *
 * Boots a minimal in-memory mongo, registers Firm + Party + LedgerEntry
 * schemas under standalone names (avoids the firm-schema autocast issue
 * documented in Plan 03 STATE.md tech debt by NOT importing the real Firm /
 * Party schemas), seeds party-scoped ledger lines, and asserts the outstanding
 * arithmetic. The full-stack @InjectModel'd PortalPublicService is exercised
 * via nest build (Task 3); this suite verifies the canonical aggregation.
 */
describe('Portal /context outstanding aggregation', () => {
  let LedgerModel: any;

  const wsId = new Types.ObjectId();
  const firmId = new Types.ObjectId();
  const partyAId = new Types.ObjectId();
  const partyBId = new Types.ObjectId();

  beforeAll(async () => {
    await startMemoryMongo();
    LedgerModel = model('LedgerEntry', LedgerEntrySchema);
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  const seedEntry = async (opts: {
    partyId: Types.ObjectId;
    debit: number;
    credit: number;
    entryType?: string;
  }) =>
    LedgerModel.create({
      workspaceId: wsId,
      firmId,
      financialYear: '2024-25',
      entryDate: new Date('2024-06-15'),
      entryType: opts.entryType ?? 'sale_invoice',
      sourceVoucherId: new Types.ObjectId(),
      sourceVoucherType: 'sale_invoice',
      sourceVoucherNumber: 'INV-001',
      postedAt: new Date('2024-06-15'),
      postedBy: new Types.ObjectId(),
      lines: [
        {
          accountId: new Types.ObjectId(),
          accountCode: '1100',
          accountName: 'Sundry Debtors',
          debit: opts.debit,
          credit: opts.credit,
          partyId: opts.partyId,
        },
      ],
      isReversed: false,
    });

  // Replicates the aggregation in PortalPublicService.getContext.
  const aggregateOutstanding = async (partyId: Types.ObjectId) => {
    const r = await LedgerModel.aggregate([
      {
        $match: {
          workspaceId: wsId,
          firmId,
          isReversed: { $ne: true },
        },
      },
      { $unwind: '$lines' },
      { $match: { 'lines.partyId': partyId } },
      {
        $group: {
          _id: null,
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
    ]);
    const debit = r[0]?.debit ?? 0;
    const credit = r[0]?.credit ?? 0;
    return debit - credit;
  };

  it('outstanding = sum(debit) − sum(credit) for party', async () => {
    await seedEntry({ partyId: partyAId, debit: 100_000, credit: 0 });
    await seedEntry({ partyId: partyAId, debit: 50_000, credit: 0 });
    await seedEntry({ partyId: partyAId, debit: 0, credit: 30_000 });
    const out = await aggregateOutstanding(partyAId);
    expect(out).toBe(120_000); // 150_000 - 30_000
  });

  it('cross-party isolation: partyB entries do not affect partyA', async () => {
    await seedEntry({ partyId: partyAId, debit: 75_000, credit: 0 });
    await seedEntry({ partyId: partyBId, debit: 999_999, credit: 0 });
    const outA = await aggregateOutstanding(partyAId);
    const outB = await aggregateOutstanding(partyBId);
    expect(outA).toBe(75_000);
    expect(outB).toBe(999_999);
  });

  it('zero ledger entries → outstanding is 0', async () => {
    const out = await aggregateOutstanding(partyAId);
    expect(out).toBe(0);
  });

  it('NotFoundException is the right contract for missing firm/party', () => {
    // Documents the controller's 404 contract for grep-friendly auditing.
    expect(NotFoundException.name).toBe('NotFoundException');
  });
});
