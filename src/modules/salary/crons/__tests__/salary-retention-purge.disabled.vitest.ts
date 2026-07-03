/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Salary retention purge — ENV flag OFF test (OQ-S4 safety gate).
 *
 * The purge job MUST default to OFF. With RUN_RETENTION_PURGE_ON_SCHEDULE
 * unset (or false), handlePurge() must exit before touching any data.
 * This test mocks the env to disabled and verifies no deleteMany is called.
 *
 * The enabled-path (floor + status filters) is covered by the sibling test
 * salary-retention-purge.cron.vitest.ts which forces enabled:true.
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

// *** IMPORTANT: the env must be mocked BEFORE importing the cron class so the
// module captures the mocked value (vitest hoists vi.mock to the top of scope).
vi.mock('../../../../config/env', () => ({
  env: {
    // Disabled — the cron should short-circuit without touching any model.
    salaryRetention: { enabled: false, payrollYears: 8, wageLedgerYears: 10 },
  },
}));

import { SalaryRetentionPurgeCron } from '../salary-retention-purge.cron';

function makeDeleteModel() {
  return {
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    find: vi.fn(),
    findOne: vi.fn(),
  } as any;
}

describe('SalaryRetentionPurgeCron — purge disabled by default (OQ-S4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips all deleteMany calls when RUN_RETENTION_PURGE_ON_SCHEDULE is false', async () => {
    const workspaceModel = makeDeleteModel();
    const payrollConfigModel = makeDeleteModel();
    const salary = makeDeleteModel();
    const payment = makeDeleteModel();
    const adjustment = makeDeleteModel();
    const increment = makeDeleteModel();
    const taxDecl = makeDeleteModel();
    const gratuity = makeDeleteModel();
    const fnf = makeDeleteModel();
    const recoveryPlan = makeDeleteModel();
    const advanceReq = makeDeleteModel();
    const loan = makeDeleteModel();
    const commission = makeDeleteModel();
    const cashLedger = makeDeleteModel();
    const singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    } as any;

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

    // No data model must be queried or mutated when the flag is off.
    expect(workspaceModel.find).not.toHaveBeenCalled();
    expect(salary.deleteMany).not.toHaveBeenCalled();
    expect(payment.deleteMany).not.toHaveBeenCalled();
    expect(cashLedger.deleteMany).not.toHaveBeenCalled();
    expect(loan.deleteMany).not.toHaveBeenCalled();
    expect(commission.deleteMany).not.toHaveBeenCalled();
    // The single-flight must NOT even be entered (short-circuit before it).
    expect(singleFlight.runExclusive).not.toHaveBeenCalled();
  });
});
