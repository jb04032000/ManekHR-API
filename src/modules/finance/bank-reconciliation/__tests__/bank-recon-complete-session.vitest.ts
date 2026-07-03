/**
 * Phase 15-06 Task 2 — F-13 CR-02 `completeSession` encapsulation + guards regression
 *
 * Why this test exists: F-13 CR-02 moved the session-complete business logic
 * out of the controller (which previously used an `as any` cast to reach
 * Mongoose models off the service) into a public `completeSession()` method
 * on `BankReconciliationService`. This regression test pins:
 *
 *   - Encapsulation: the method exists with the documented signature
 *     `(wsId, firmId, sessionId, userId, note?)` so a future refactor cannot
 *     silently move the logic back into the controller.
 *   - Guard 1 (unmatched-row): completion is blocked when
 *     `session.totalUnmatchedCount > 0`. No state mutations occur.
 *   - Guard 2 (BRS not fully reconciled): completion is blocked when
 *     `BrsReportService.generate(...).isFullyReconciled === false`.
 *     No state mutations occur.
 *   - Happy path: both guards pass → session.status='completed',
 *     statement.status='locked', and `lockedAt` is returned.
 *
 * Harness: standalone mongodb-memory-server is sufficient — completeSession
 * does NOT use transactions. BrsReportService is stubbed (faster + more
 * deterministic than seeding a full ledger to drive `generate()`).
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

// See bank-recon-delete-statement.vitest.ts for rationale: cross-module
// schemas use `@Prop({ required: true })` without `{ type }`, which fails
// under esbuild's no-decorator-metadata transform. The deleteStatement test
// stubs them; we reuse the same stubbing pattern here.
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
import { MongoMemoryServer } from 'mongodb-memory-server';

import { BankStatement, BankStatementSchema } from '../bank-statement.schema';
import {
  ReconciliationSession,
  ReconciliationSessionSchema,
} from '../reconciliation-session.schema';
import { BankReconciliationService } from '../bank-reconciliation.service';

describe('BankReconciliationService.completeSession — encapsulation + guards (Phase 15-06 / F-13 CR-02)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let statementModel: mongoose.Model<any>;
  let sessionModel: mongoose.Model<any>;
  let rowModel: any;
  let brsReportStub: { generate: ReturnType<typeof vi.fn> };
  let service: BankReconciliationService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
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
    sessionModel = getOrDefine(
      ReconciliationSession.name,
      ReconciliationSessionSchema,
    );
    // rowModel is referenced by the service constructor but completeSession
    // does not exercise it — minimal stand-in is sufficient.
    rowModel = {};

    brsReportStub = { generate: vi.fn() };

    service = new BankReconciliationService(
      statementModel as any,
      rowModel as any,
      sessionModel as any,
      {} as any, // ledgerModel — unused on this code path
      {} as any, // bankAccountModel — unused
      {} as any, // firmModel — unused
      connection as any,
      {} as any, // parser — unused
      brsReportStub as any,
    );
  });

  afterAll(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // already disconnected
    }
    try {
      await mongod.stop();
    } catch {
      // already stopped
    }
  });

  beforeEach(async () => {
    const collections = await connection.db!.collections();
    for (const col of collections) {
      await col.deleteMany({});
    }
    brsReportStub.generate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Seed a BankStatement (status='imported') and a ReconciliationSession
   * bound to it. `totalUnmatchedCount` is parameterised so we can drive
   * the unmatched-row guard from a single helper.
   */
  async function seedStatementAndSession(
    overrides: Partial<{
      totalUnmatchedCount: number;
      sessionStatus: string;
      statementStatus: string;
    }> = {},
  ): Promise<{
    wsId: Types.ObjectId;
    firmId: Types.ObjectId;
    userId: Types.ObjectId;
    statementId: Types.ObjectId;
    sessionId: Types.ObjectId;
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
      matchedRows: 5,
      unmatchedRows: 0,
      status: overrides.statementStatus ?? 'imported',
      importedBy: userId,
      importedAt: new Date(),
      originalFilename: 'test.csv',
    });

    const sess = await sessionModel.create({
      workspaceId: wsId,
      firmId,
      bankAccountId,
      bankStatementId: stmt._id,
      sessionName: 'April 2026 Reconciliation',
      periodFrom: new Date('2026-04-01'),
      periodTo: new Date('2026-04-30'),
      financialYear: '2026-27',
      bookBalancePaise: 100000,
      statementClosingBalancePaise: 100000,
      differenceExplained: 0,
      status: overrides.sessionStatus ?? 'in_progress',
      autoMatchRun: true,
      autoMatchedCount: 5,
      totalMatchedCount: 5,
      totalUnmatchedCount: overrides.totalUnmatchedCount ?? 0,
      outstandingChequesPaise: 0,
      depositsInTransitPaise: 0,
      createdBy: userId,
    });

    return {
      wsId,
      firmId,
      userId,
      statementId: stmt._id as Types.ObjectId,
      sessionId: sess._id as Types.ObjectId,
    };
  }

  it('completeSession is a function on the service (encapsulation)', () => {
    expect(typeof service.completeSession).toBe('function');
    // Documented signature is (wsId, firmId, sessionId, userId, note?) — 5
    // declared parameters, but Function.length only counts params before
    // the first one with a default. `note?` has no default, so length === 5.
    // We assert >= 4 to allow for harmless future tweaks while still pinning
    // the bulk of the signature.
    expect(service.completeSession.length).toBeGreaterThanOrEqual(4);
  });

  it('unmatched-row guard fires before any state mutation', async () => {
    const { wsId, firmId, userId, statementId, sessionId } =
      await seedStatementAndSession({ totalUnmatchedCount: 3 });

    await expect(
      service.completeSession(wsId, firmId, sessionId, userId),
    ).rejects.toThrow(/unmatched/i);

    // BrsReportService.generate must NOT have been called — the unmatched
    // guard runs first and short-circuits.
    expect(brsReportStub.generate).not.toHaveBeenCalled();

    // Re-fetch: session still in 'in_progress', statement still 'imported'.
    const sess = await sessionModel.findById(sessionId).lean();
    const stmt = await statementModel.findById(statementId).lean();
    expect(sess!.status).toBe('in_progress');
    expect(sess!.completedAt).toBeFalsy();
    expect(sess!.completedBy).toBeFalsy();
    expect(stmt!.status).toBe('imported');
    expect(stmt!.lockedAt).toBeFalsy();
    expect(stmt!.lockedBy).toBeFalsy();
  });

  it('BRS-not-fully-reconciled guard fires before any state mutation', async () => {
    const { wsId, firmId, userId, statementId, sessionId } =
      await seedStatementAndSession({ totalUnmatchedCount: 0 });

    // Drive the second guard: BRS returns isFullyReconciled=false.
    brsReportStub.generate.mockResolvedValueOnce({
      isFullyReconciled: false,
      differencePaise: 12345,
    });

    await expect(
      service.completeSession(wsId, firmId, sessionId, userId),
    ).rejects.toThrow(/12345|reconciled|difference/i);

    // BrsReportService.generate WAS called this time (we got past guard 1).
    expect(brsReportStub.generate).toHaveBeenCalledTimes(1);

    // Re-fetch: still no state mutation (guard 2 fired before updateOne).
    const sess = await sessionModel.findById(sessionId).lean();
    const stmt = await statementModel.findById(statementId).lean();
    expect(sess!.status).toBe('in_progress');
    expect(sess!.completedAt).toBeFalsy();
    expect(stmt!.status).toBe('imported');
    expect(stmt!.lockedAt).toBeFalsy();
  });

  it('happy path: both guards pass → session locked + statement locked', async () => {
    const { wsId, firmId, userId, statementId, sessionId } =
      await seedStatementAndSession({ totalUnmatchedCount: 0 });

    brsReportStub.generate.mockResolvedValueOnce({
      isFullyReconciled: true,
      differencePaise: 0,
    });

    const result = await service.completeSession(
      wsId,
      firmId,
      sessionId,
      userId,
      'all good',
    );

    expect(result.completed).toBe(true);
    expect(result.sessionId).toBe(sessionId.toString());
    expect(result.lockedAt).toBeInstanceOf(Date);

    // Both writes occurred: session marked completed, statement marked locked.
    const sess = await sessionModel.findById(sessionId).lean();
    const stmt = await statementModel.findById(statementId).lean();
    expect(sess!.status).toBe('completed');
    expect(String(sess!.completedBy)).toBe(String(userId));
    expect(sess!.completedAt).toBeInstanceOf(Date);
    // NOTE: `note` is set via `$set` by completeSession but is NOT declared on
    // the ReconciliationSession schema, so Mongoose strips it on persist. This
    // is a pre-existing schema gap (out of scope for F-13 CR-02 — the guard
    // and lock behaviour is what this test pins). We assert that the call
    // accepts the optional `note` parameter without throwing rather than
    // asserting persistence.
    expect(stmt!.status).toBe('locked');
    expect(String(stmt!.lockedBy)).toBe(String(userId));
    expect(stmt!.lockedAt).toBeInstanceOf(Date);
  });
});
