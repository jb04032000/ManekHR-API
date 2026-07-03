/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Salary retention purge — HARD statutory floor (security-review fix HIGH-2) +
 * updatedAt anchoring / terminal-status exclusion (MEDIUM-1).
 *
 * The destructive, irreversible purge must NEVER drop below the 8y/10y statutory
 * floor, regardless of the env value OR a per-workspace override. These tests pin
 * a 1-year env value AND a 1-year workspace override and assert the resulting
 * deleteMany cutoff is still ~8 years (payroll) / ~10 years (wage) in the past,
 * anchored on `updatedAt`, and that live (non-terminal) loans/schedules/recovery
 * plans are excluded.
 * Links: salary-retention-purge.cron.ts (STATUTORY_*_FLOOR_YEARS).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

// Force a DELIBERATELY-TOO-LOW env value (1 year) so the test proves the hard
// code floor — not the env — wins. `enabled: true` so handlePurge runs the body.
vi.mock('../../../../config/env', () => ({
  env: {
    salaryRetention: { enabled: true, payrollYears: 1, wageLedgerYears: 1 },
  },
}));

import { Types } from 'mongoose';
import {
  SalaryRetentionPurgeCron,
  STATUTORY_PAYROLL_FLOOR_YEARS,
  STATUTORY_WAGE_FLOOR_YEARS,
} from '../salary-retention-purge.cron';

// Single-flight stub that just runs the body (claim always granted).
const singleFlight = {
  runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
} as any;

// Capture deleteMany filters per collection so we can assert the cutoff + status.
function captureModel(captured: Record<string, any[]>, key: string) {
  return {
    deleteMany: vi.fn((filter: any) => {
      (captured[key] ??= []).push(filter);
      return Promise.resolve({ deletedCount: 0 });
    }),
  } as any;
}

function yearsAgo(date: Date): number {
  return (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

describe('SalaryRetentionPurgeCron — statutory floor (HIGH-2) + anchoring (MEDIUM-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the legal floor constants as 8y / 10y', () => {
    expect(STATUTORY_PAYROLL_FLOOR_YEARS).toBe(8);
    expect(STATUTORY_WAGE_FLOOR_YEARS).toBe(10);
  });

  it('clamps a 1-year env value AND a 1-year workspace override up to the 8y/10y floor', async () => {
    const captured: Record<string, any[]> = {};
    const wsOid = new Types.ObjectId();

    const workspaceModel = {
      find: () => ({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve([{ _id: wsOid, name: 'WS' }]) }),
        }),
      }),
    } as any;

    // Per-workspace override is ALSO 1 year — must still be clamped up.
    const payrollConfigModel = {
      findOne: () => ({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve({ retention: { payrollYears: 1, wageLedgerYears: 1 } }),
          }),
        }),
      }),
    } as any;

    const salary = captureModel(captured, 'salary');
    const cashLedger = captureModel(captured, 'cashLedger');
    const payment = captureModel(captured, 'payment');
    const adjustment = captureModel(captured, 'adjustment');
    const increment = captureModel(captured, 'increment');
    const taxDecl = captureModel(captured, 'taxDecl');
    const gratuity = captureModel(captured, 'gratuity');
    const fnf = captureModel(captured, 'fnf');
    const recoveryPlan = captureModel(captured, 'recoveryPlan');
    const advanceReq = captureModel(captured, 'advanceReq');
    const loan = captureModel(captured, 'loan');
    const commission = captureModel(captured, 'commission');

    const cron = new SalaryRetentionPurgeCron(
      workspaceModel,
      payrollConfigModel,
      salary,
      payment,
      adjustment,
      increment,
      taxDecl,
      gratuity,
      fnf,
      recoveryPlan,
      advanceReq,
      loan,
      commission,
      cashLedger,
      singleFlight,
    );

    await cron.handlePurge();

    // Wage window (Salary register + cash ledger) clamps to ~10y despite 1y inputs.
    const salaryCutoff: Date = captured.salary[0].updatedAt.$lt;
    const cashCutoff: Date = captured.cashLedger[0].updatedAt.$lt;
    expect(yearsAgo(salaryCutoff)).toBeGreaterThanOrEqual(9.9);
    expect(yearsAgo(salaryCutoff)).toBeLessThan(10.2);
    expect(yearsAgo(cashCutoff)).toBeGreaterThanOrEqual(9.9);

    // Payroll window clamps to ~8y despite 1y inputs.
    const paymentCutoff: Date = captured.payment[0].updatedAt.$lt;
    expect(yearsAgo(paymentCutoff)).toBeGreaterThanOrEqual(7.9);
    expect(yearsAgo(paymentCutoff)).toBeLessThan(8.2);

    // MEDIUM-1: cutoff is anchored on updatedAt, NOT createdAt.
    expect(captured.adjustment[0]).toHaveProperty('updatedAt');
    expect(captured.adjustment[0]).not.toHaveProperty('createdAt');

    // MEDIUM-1: live (non-terminal) loans / schedules / recovery plans excluded.
    expect(captured.loan[0].status).toEqual({
      $nin: ['draft', 'pending_approval', 'active', 'paused'],
    });
    expect(captured.commission[0].status).toEqual({ $nin: ['active', 'paused'] });
    expect(captured.recoveryPlan[0].status).toEqual({ $nin: ['active', 'paused'] });
    // Plain payroll collections carry no status filter (all rows are statutory).
    expect(captured.payment[0]).not.toHaveProperty('status');
    expect(captured.increment[0]).not.toHaveProperty('status');
  });
});
