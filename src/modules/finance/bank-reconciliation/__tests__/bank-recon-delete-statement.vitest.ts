/**
 * Phase 15-06 Task 1 — F-13 CR-01 transactional `deleteStatement` rollback regression
 *
 * Harness mode: replica-set (transactions require a replica-set-capable
 * mongodb-memory-server instance; the shared `createTestMongoose` helper
 * spins up a STANDALONE server which does NOT support multi-document
 * transactions). This suite owns its own `MongoMemoryReplSet` lifecycle
 * scoped to this file ONLY — the shared helper is left untouched so
 * unrelated suites are not affected.
 *
 * Scenario:
 *   - Seed 1 BankStatement (status='imported'), 5 BankStatementRow docs,
 *     and 1 ReconciliationSession bound to that statement.
 *   - Spy on `statementModel.deleteOne` and force it to throw on first call.
 *     This is the LAST of the three operations inside the withTransaction
 *     callback (rowModel.deleteMany → sessionModel.deleteMany → statementModel.deleteOne),
 *     so by the time it throws the first two deletes have already been
 *     issued under the transaction; rollback must restore them.
 *   - Call `deleteStatement(...)` and expect it to throw.
 *   - Re-fetch from DB and assert all seeded docs are still present
 *     (rollback succeeded — no orphan rows or sessions).
 *
 * If a future change reintroduces a non-transactional delete sequence,
 * partial state will leak past the throw and this test will fail.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vitest';

// Cross-module schemas imported by `bank-reconciliation.service.ts` use
// `@Prop({ required: true })` without an explicit `{ type }` option. Outside
// the SWC integration plugin's scope (which only transforms files under
// __tests__/ and test-utils/), Vitest's default esbuild transform omits
// decorator metadata, so SchemaFactory.createForClass throws "Cannot
// determine a type for ..." when these modules load. Stubbing them keeps
// the import graph satisfied without forcing us to load real schemas we
// don't exercise on the deleteStatement code path.
vi.mock('../../bank-accounts/bank-account.schema', () => ({
  BankAccount: { name: 'BankAccount' },
  BankAccountSchema: {},
}));
vi.mock('../../firms/firm.schema', () => ({
  Firm: { name: 'Firm' },
  FirmSchema: {},
}));
vi.mock('../../sales/ledger-posting/ledger-entry.schema', () => ({
  LedgerEntry: { name: 'LedgerEntry' },
  LedgerEntrySchema: {},
}));

import mongoose, { Types, Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { BankStatement, BankStatementSchema } from '../bank-statement.schema';
import {
  BankStatementRow,
  BankStatementRowSchema,
} from '../bank-statement-row.schema';
import {
  ReconciliationSession,
  ReconciliationSessionSchema,
} from '../reconciliation-session.schema';
import { BankReconciliationService } from '../bank-reconciliation.service';

describe('BankReconciliationService.deleteStatement — transactional rollback (Phase 15-06 / F-13 CR-01)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let statementModel: mongoose.Model<any>;
  let rowModel: mongoose.Model<any>;
  let sessionModel: mongoose.Model<any>;
  let service: BankReconciliationService;

  beforeAll(async () => {
    // count: 1 → single-node replica set is sufficient for transaction support.
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    await mongoose.connect(uri);
    connection = mongoose.connection;

    function getOrDefine<T>(
      name: string,
      schema: mongoose.Schema,
    ): mongoose.Model<T> {
      try {
        return mongoose.model<T>(name);
      } catch {
        return mongoose.model<T>(name, schema);
      }
    }

    statementModel = getOrDefine(BankStatement.name, BankStatementSchema);
    rowModel = getOrDefine(BankStatementRow.name, BankStatementRowSchema);
    sessionModel = getOrDefine(
      ReconciliationSession.name,
      ReconciliationSessionSchema,
    );

    await statementModel.syncIndexes();
    await rowModel.syncIndexes();
    await sessionModel.syncIndexes();

    // Construct the service directly. Only `connection`, `statementModel`,
    // `rowModel`, and `sessionModel` are exercised by `deleteStatement`;
    // the other dependencies are unused on this code path so we pass
    // minimal stand-ins typed as `any`.
    service = new BankReconciliationService(
      statementModel as any,
      rowModel as any,
      sessionModel as any,
      {} as any, // ledgerModel — unused
      {} as any, // bankAccountModel — unused
      {} as any, // firmModel — unused
      connection as any,
      {} as any, // parser — unused
      {} as any, // brsReport — unused
    );
  });

  afterAll(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // already disconnected
    }
    try {
      await replSet.stop();
    } catch {
      // already stopped
    }
  });

  beforeEach(async () => {
    const collections = await connection.db!.collections();
    for (const col of collections) {
      await col.deleteMany({});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedStatementWithRowsAndSession(): Promise<{
    wsId: Types.ObjectId;
    firmId: Types.ObjectId;
    statementId: Types.ObjectId;
  }> {
    const wsId = new Types.ObjectId();
    const firmId = new Types.ObjectId();
    const bankAccountId = new Types.ObjectId();
    const userId = new Types.ObjectId();

    const stmt = await statementModel.create({
      workspaceId: wsId,
      firmId,
      bankAccountId,
      bankName: 'Test Bank',
      detectedFormat: 'generic',
      statementDateFrom: new Date('2026-04-01'),
      statementDateTo: new Date('2026-04-30'),
      financialYear: '2026-27',
      openingBalancePaise: 0,
      closingBalancePaise: 100000,
      totalRows: 5,
      matchedRows: 0,
      unmatchedRows: 5,
      status: 'imported',
      importedBy: userId,
      importedAt: new Date(),
      originalFilename: 'test.csv',
    });
    const statementId = stmt._id as Types.ObjectId;

    // Seed 5 rows.
    for (let i = 0; i < 5; i++) {
      await rowModel.create({
        workspaceId: wsId,
        firmId,
        bankStatementId: statementId,
        bankAccountId,
        rowIndex: i,
        txnDate: new Date(`2026-04-${String(i + 1).padStart(2, '0')}`),
        narration: `Test txn ${i}`,
        narrationNorm: `test txn ${i}`,
        debitPaise: 0,
        creditPaise: 1000,
        amountPaise: 1000,
        status: 'unmatched',
        matchedLedgerEntryIds: [],
        matchedVoucherIds: [],
        matchedVoucherTypes: [],
        topSuggestions: [],
      });
    }

    // Seed 1 reconciliation session bound to the statement.
    await sessionModel.create({
      workspaceId: wsId,
      firmId,
      bankAccountId,
      bankStatementId: statementId,
      sessionName: 'April 2026 Reconciliation',
      periodFrom: new Date('2026-04-01'),
      periodTo: new Date('2026-04-30'),
      financialYear: '2026-27',
      bookBalancePaise: 100000,
      statementClosingBalancePaise: 100000,
      differenceExplained: 0,
      status: 'draft',
      autoMatchRun: false,
      autoMatchedCount: 0,
      totalMatchedCount: 0,
      totalUnmatchedCount: 5,
      outstandingChequesPaise: 0,
      depositsInTransitPaise: 0,
      createdBy: userId,
    });

    return { wsId, firmId, statementId };
  }

  it('deleteStatement rolls back all deletes when one operation throws mid-transaction', async () => {
    const { wsId, firmId, statementId } =
      await seedStatementWithRowsAndSession();

    // Sanity: pre-state looks right.
    expect(await statementModel.countDocuments({ _id: statementId })).toBe(1);
    expect(
      await rowModel.countDocuments({ bankStatementId: statementId }),
    ).toBe(5);
    expect(
      await sessionModel.countDocuments({ bankStatementId: statementId }),
    ).toBe(1);

    // Inject failure on the LAST delete inside the withTransaction callback.
    // The service calls (in order):
    //   rowModel.deleteMany({...}, {session})
    //   sessionModel.deleteMany({...}, {session})
    //   statementModel.deleteOne({...}, {session})
    // Forcing statementModel.deleteOne to throw means the first two deletes
    // have been issued under the transaction; rollback must undo them.
    const deleteOneSpy = vi
      .spyOn(statementModel, 'deleteOne')
      .mockImplementationOnce(() => {
        throw new Error('Forced mid-transaction failure');
      });

    await expect(
      service.deleteStatement(wsId, firmId, statementId),
    ).rejects.toThrow(/Forced mid-transaction failure/);

    // Restore the spy so subsequent assertions hit the real driver.
    deleteOneSpy.mockRestore();

    // Assertion 1: BankStatement still exists (rollback restored it).
    const stillThere = await statementModel.findById(statementId).lean();
    expect(stillThere).not.toBeNull();
    expect(String(stillThere!._id)).toBe(String(statementId));

    // Assertion 2: BankStatementRow count is unchanged (still 5).
    const rowCount = await rowModel.countDocuments({
      bankStatementId: statementId,
    });
    expect(rowCount).toBe(5);

    // Assertion 3: ReconciliationSession still exists.
    const sessCount = await sessionModel.countDocuments({
      bankStatementId: statementId,
    });
    expect(sessCount).toBe(1);
  });

  it('deleteStatement happy-path still works (sanity baseline for the rollback test)', async () => {
    const { wsId, firmId, statementId } =
      await seedStatementWithRowsAndSession();

    await service.deleteStatement(wsId, firmId, statementId);

    expect(await statementModel.countDocuments({ _id: statementId })).toBe(0);
    expect(
      await rowModel.countDocuments({ bankStatementId: statementId }),
    ).toBe(0);
    expect(
      await sessionModel.countDocuments({ bankStatementId: statementId }),
    ).toBe(0);
  });
});
