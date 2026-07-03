/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * CashLedgerService unit tests (Phase 3C - Daily-Wage Running Ledger).
 *
 * Strategy: mock all Mongoose models and injected services; drive
 * CashLedgerService methods through a direct constructor call using the same
 * @nestjs/mongoose decorator-mock pattern as commission.service.vitest.ts.
 *
 * Cases:
 *   A. recordEntries
 *      A1. feature flag off throws BadRequestException
 *      A2. single earning entry created correctly
 *      A3. bulk entries for multiple workers (earning + draw) created
 *      A4. adjustment amount of 0 throws BadRequestException
 *      A5. draw amount <= 0 throws BadRequestException
 *
 *   B. Running balance (getMemberLedger + aggregate)
 *      B1. balance = earned - drawn (no settlement)
 *      B2. balance = earned - drawn - settled
 *      B3. adjustment modifies balance correctly
 *      B4. member with no entries returns balance 0
 *
 *   C. settle
 *      C1. settle pays net (earned - drawn) and creates settlement entry
 *      C2. settle marks covered entries with settledInEntryId
 *      C3. settle returns settled=false when no open entries exist
 *      C4. min-wage flag fires when earned < pro-rated minimum wage
 *      C5. min-wage flag is false when minimum wage not configured (no hard block)
 *      C6. bulk settle for multiple workers
 *
 *   D. updateEntry + softDeleteEntry
 *      D1. updateEntry changes amount and note on open entry
 *      D2. updateEntry throws on settlement type
 *      D3. updateEntry throws on already-settled entry
 *      D4. softDeleteEntry creates counter-adjustment for earning
 *      D5. softDeleteEntry throws on settlement type
 */

import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

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
import { CashLedgerService } from '../cash-ledger.service';

// ---------------------------------------------------------------------------
// Shared IDs
// ---------------------------------------------------------------------------

const workspaceId = new Types.ObjectId().toHexString();
const memberId1 = new Types.ObjectId();
const memberId2 = new Types.ObjectId();
const userId = new Types.ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Entry doc factory
// ---------------------------------------------------------------------------

function makeEntryDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(workspaceId),
    teamMemberId: memberId1,
    date: new Date('2026-05-28'),
    type: 'earning',
    amount: 500,
    note: undefined,
    createdBy: new Types.ObjectId(userId),
    settledInEntryId: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build service with mocked dependencies
// ---------------------------------------------------------------------------

function buildService(
  opts: {
    featureEnabled?: boolean;
    minWageMonthly?: number | null;
    memberOverride?: number | null;
    openEntries?: any[];
    aggBalanceResult?: any[];
    aggWorkspaceResult?: any[];
    findOneEntry?: any;
  } = {},
) {
  const {
    featureEnabled = true,
    minWageMonthly = null,
    memberOverride = null,
    openEntries = [],
    aggBalanceResult = [],
    aggWorkspaceResult = [],
    findOneEntry = null,
  } = opts;

  // CashLedgerEntry model mock
  const savedEntry = makeEntryDoc();
  const entryCtorMock = vi.fn().mockImplementation((data: any) => ({
    ...savedEntry,
    ...data,
    _id: new Types.ObjectId(),
    save: vi.fn().mockResolvedValue(undefined),
  }));

  (entryCtorMock as any).find = vi.fn().mockImplementation((_filter: any) => ({
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(openEntries),
  }));

  (entryCtorMock as any).findOne = vi.fn().mockImplementation((_filter: any) => ({
    exec: vi.fn().mockResolvedValue(findOneEntry),
  }));

  (entryCtorMock as any).countDocuments = vi.fn().mockResolvedValue(openEntries.length);

  (entryCtorMock as any).updateMany = vi
    .fn()
    .mockResolvedValue({ modifiedCount: openEntries.length });

  // Aggregate returns balance result for getMemberLedger calls,
  // and workspace agg for getWorkspaceBalances calls.
  let aggCallCount = 0;
  (entryCtorMock as any).aggregate = vi.fn().mockImplementation((_pipeline: any[]) => {
    aggCallCount++;
    // Alternate between balance agg and workspace agg as needed.
    const result = aggCallCount === 1 ? aggBalanceResult : aggWorkspaceResult;
    return { exec: vi.fn().mockResolvedValue(result) };
  });

  // PayrollConfig model mock
  const payrollConfigModelMock = {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(
        featureEnabled
          ? {
              features: { dailyWageLedger: true },
              compliance: { minimumWageMonthly: minWageMonthly },
            }
          : {
              features: { dailyWageLedger: false },
              compliance: { minimumWageMonthly: null },
            },
      ),
    }),
  };

  // TeamMember model mock. Workstream G hardening added an offboard write-lock
  // (assertMemberWritable) that does the SAME findOne; it requires a present,
  // non-deleted member. So always return a member row (with isDeleted:false) and
  // attach the min-wage override only when set — both callers stay satisfied.
  const teamMemberModelMock = {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        _id: 'member-1',
        isDeleted: false,
        ...(memberOverride !== null ? { minimumWageMonthlyOverride: memberOverride } : {}),
      }),
    }),
  };

  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const postHog = { capture: vi.fn(), identify: vi.fn() };

  const service = new CashLedgerService(
    entryCtorMock as any,
    payrollConfigModelMock as any,
    teamMemberModelMock as any,
    auditService as any,
    postHog as any,
  );

  return {
    service,
    entryCtorMock,
    payrollConfigModelMock,
    teamMemberModelMock,
    auditService,
    postHog,
  };
}

// ---------------------------------------------------------------------------
// Case A: recordEntries
// ---------------------------------------------------------------------------

describe('CashLedgerService - recordEntries', () => {
  it('A1: throws BadRequestException when feature flag is off', async () => {
    const { service } = buildService({ featureEnabled: false });
    await expect(
      service.recordEntries(
        workspaceId,
        { entries: [{ teamMemberId: String(memberId1), type: 'earning', amount: 100 }] },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('A2: single earning entry created with correct fields', async () => {
    const { service, entryCtorMock, auditService, postHog } = buildService();
    const result = await service.recordEntries(
      workspaceId,
      {
        entries: [
          { teamMemberId: String(memberId1), type: 'earning', amount: 300, note: 'Day 1 work' },
        ],
      },
      userId,
    );

    expect(result.created).toBe(1);
    expect(result.entryIds).toHaveLength(1);
    expect(entryCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'earning', amount: 300 }),
    );
    expect(auditService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cash_ledger.entry_created' }),
    );
    expect(postHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'salary.ledger_entry_created' }),
    );
  });

  it('A3: bulk entries for two workers produces two entries', async () => {
    const { service, entryCtorMock } = buildService();
    const result = await service.recordEntries(
      workspaceId,
      {
        entries: [
          { teamMemberId: String(memberId1), type: 'earning', amount: 400 },
          { teamMemberId: String(memberId2), type: 'draw', amount: 200 },
        ],
      },
      userId,
    );

    expect(result.created).toBe(2);
    expect(result.entryIds).toHaveLength(2);
    expect(entryCtorMock).toHaveBeenCalledTimes(2);
  });

  it('A4: adjustment amount of 0 throws BadRequestException', async () => {
    const { service } = buildService();
    await expect(
      service.recordEntries(
        workspaceId,
        { entries: [{ teamMemberId: String(memberId1), type: 'adjustment', amount: 0 }] },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('A5: draw amount <= 0 throws BadRequestException', async () => {
    const { service } = buildService();
    await expect(
      service.recordEntries(
        workspaceId,
        { entries: [{ teamMemberId: String(memberId1), type: 'draw', amount: -50 }] },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// Case B: Running balance (getMemberLedger)
// ---------------------------------------------------------------------------

describe('CashLedgerService - getMemberLedger running balance', () => {
  it('B1: balance = earned - drawn (no settlement)', async () => {
    const balanceRow = {
      _id: null,
      totalEarning: 1000,
      totalDraw: 300,
      totalSettlement: 0,
      netAdjustment: 0,
    };
    const { service } = buildService({ aggBalanceResult: [balanceRow] });
    const result = await service.getMemberLedger(workspaceId, String(memberId1), {});
    expect(result.currentBalance).toBe(700); // 1000 - 300
  });

  it('B2: balance = earned - drawn - settled', async () => {
    const balanceRow = {
      _id: null,
      totalEarning: 1500,
      totalDraw: 400,
      totalSettlement: 600,
      netAdjustment: 0,
    };
    const { service } = buildService({ aggBalanceResult: [balanceRow] });
    const result = await service.getMemberLedger(workspaceId, String(memberId1), {});
    expect(result.currentBalance).toBe(500); // 1500 - 400 - 600
  });

  it('B3: adjustment modifies balance', async () => {
    const balanceRow = {
      _id: null,
      totalEarning: 800,
      totalDraw: 200,
      totalSettlement: 0,
      netAdjustment: -50, // correction
    };
    const { service } = buildService({ aggBalanceResult: [balanceRow] });
    const result = await service.getMemberLedger(workspaceId, String(memberId1), {});
    expect(result.currentBalance).toBe(550); // 800 - 200 + (-50)
  });

  it('B4: member with no entries returns balance 0', async () => {
    // Aggregate returns empty array
    const { service } = buildService({ aggBalanceResult: [] });
    const result = await service.getMemberLedger(workspaceId, String(memberId1), {});
    expect(result.currentBalance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case C: settle
// ---------------------------------------------------------------------------

describe('CashLedgerService - settle', () => {
  const earningEntry = makeEntryDoc({ type: 'earning', amount: 800, date: new Date('2026-05-26') });
  const drawEntry = makeEntryDoc({ type: 'draw', amount: 300, date: new Date('2026-05-27') });

  it('C1: settle pays net (earned - drawn) and creates settlement entry', async () => {
    const { service, entryCtorMock } = buildService({ openEntries: [earningEntry, drawEntry] });
    const result = await service.settle(
      workspaceId,
      { teamMemberIds: [String(memberId1)] },
      userId,
    );

    expect(result.results).toHaveLength(1);
    const r = result.results[0];
    expect(r.settled).toBe(true);
    expect(r.settledAmount).toBe(500); // 800 - 300
    expect(r.settlementEntryId).toBeTruthy();
    // settlement entry was constructed
    expect(entryCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settlement', amount: 500 }),
    );
  });

  it('C2: settle marks covered entries with settledInEntryId', async () => {
    const { service, entryCtorMock } = buildService({ openEntries: [earningEntry, drawEntry] });
    await service.settle(workspaceId, { teamMemberIds: [String(memberId1)] }, userId);

    // updateMany should be called to mark the covered entries
    const modelInstance = entryCtorMock as any;
    expect(modelInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: expect.any(Array) } }),
      expect.objectContaining({ $set: { settledInEntryId: expect.any(Object) } }),
    );
  });

  it('C3: settle returns settled=false when no open entries exist', async () => {
    const { service } = buildService({ openEntries: [] });
    const result = await service.settle(
      workspaceId,
      { teamMemberIds: [String(memberId1)] },
      userId,
    );

    expect(result.results[0].settled).toBe(false);
    expect(result.results[0].settledAmount).toBe(0);
  });

  it('C4: min-wage flag fires when earned < pro-rated minimum wage', async () => {
    // Worker earned Rs 100 over 1 day; minimum wage = Rs 10000/month
    // Pro-rated = 10000/30 * 1 = Rs 333.33 => flag = true
    const lowEarningEntry = makeEntryDoc({
      type: 'earning',
      amount: 100,
      date: new Date('2026-05-28'),
    });
    const { service } = buildService({
      openEntries: [lowEarningEntry],
      minWageMonthly: 10000,
    });
    const result = await service.settle(
      workspaceId,
      { teamMemberIds: [String(memberId1)] },
      userId,
    );

    const r = result.results[0];
    expect(r.minimumWageFlag.flag).toBe(true);
    expect(r.minimumWageFlag.effectiveMinWageMonthly).toBe(10000);
    expect(r.minimumWageFlag.periodEarned).toBe(100);
    expect(r.minimumWageFlag.proratedMinWage).toBeGreaterThan(100);
  });

  it('C5: min-wage flag is false (no block) when minimum wage not configured', async () => {
    const entry = makeEntryDoc({ type: 'earning', amount: 100 });
    const { service } = buildService({ openEntries: [entry], minWageMonthly: null });
    const result = await service.settle(
      workspaceId,
      { teamMemberIds: [String(memberId1)] },
      userId,
    );

    const r = result.results[0];
    expect(r.minimumWageFlag.flag).toBe(false);
    expect(r.minimumWageFlag.effectiveMinWageMonthly).toBeNull();
  });

  it('C6: bulk settle for multiple workers returns one result per worker', async () => {
    const entries1 = [makeEntryDoc({ type: 'earning', amount: 600, teamMemberId: memberId1 })];
    const entries2 = [makeEntryDoc({ type: 'earning', amount: 900, teamMemberId: memberId2 })];

    // We need find() to return different results per call; override the mock manually
    const baseService = buildService({ openEntries: entries1 });

    // Override find to alternate between the two member entry sets
    let findCallCount = 0;
    (baseService.entryCtorMock as any).find = vi.fn().mockImplementation(() => ({
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(findCallCount++ === 0 ? entries1 : entries2),
    }));

    const result = await baseService.service.settle(
      workspaceId,
      { teamMemberIds: [String(memberId1), String(memberId2)] },
      userId,
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0].settled).toBe(true);
    expect(result.results[1].settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case D: updateEntry + softDeleteEntry
// ---------------------------------------------------------------------------

describe('CashLedgerService - updateEntry', () => {
  it('D1: updateEntry changes amount and note on open earning entry', async () => {
    const entryDoc = makeEntryDoc({ type: 'earning', amount: 400, note: 'old note' });
    const { service } = buildService({ findOneEntry: entryDoc });

    const updated = await service.updateEntry(
      workspaceId,
      String(entryDoc._id),
      { amount: 500, note: 'corrected' },
      userId,
    );

    expect(updated.amount).toBe(500);
    expect(updated.note).toBe('corrected');
  });

  it('D2: updateEntry throws BadRequestException for settlement type', async () => {
    const settlementDoc = makeEntryDoc({ type: 'settlement', amount: 700 });
    const { service } = buildService({ findOneEntry: settlementDoc });

    await expect(
      service.updateEntry(workspaceId, String(settlementDoc._id), { amount: 800 }, userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('D3: updateEntry throws BadRequestException when entry is already settled', async () => {
    const settledEntry = makeEntryDoc({
      type: 'earning',
      amount: 500,
      settledInEntryId: new Types.ObjectId(),
    });
    const { service } = buildService({ findOneEntry: settledEntry });

    await expect(
      service.updateEntry(workspaceId, String(settledEntry._id), { amount: 600 }, userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CashLedgerService - softDeleteEntry', () => {
  it('D4: softDeleteEntry creates counter-adjustment for earning', async () => {
    const earningDoc = makeEntryDoc({ type: 'earning', amount: 300 });
    const { service, entryCtorMock } = buildService({ findOneEntry: earningDoc });

    const result = await service.softDeleteEntry(workspaceId, String(earningDoc._id), userId);

    expect(result.deleted).toBe(true);
    expect(result.correctionEntryId).toBeTruthy();
    // Counter for earning is negative adjustment
    expect(entryCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'adjustment', amount: -300 }),
    );
  });

  it('D5: softDeleteEntry throws BadRequestException for settlement type', async () => {
    const settlementDoc = makeEntryDoc({ type: 'settlement', amount: 700 });
    const { service } = buildService({ findOneEntry: settlementDoc });

    await expect(
      service.softDeleteEntry(workspaceId, String(settlementDoc._id), userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
