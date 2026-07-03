/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * Phase 7 audit-at-purge (ACCOUNT-DELETION-AND-DPDP-PLAN.md §8): the salary
 * retention purge must leave a grievance-trail audit per workspace it purges —
 * record classes (per-collection counts), the legal basis, and the elapsed-window
 * cutoffs. Best-effort: it fires only when rows were actually deleted, and an
 * audit failure never aborts the (already-completed) purge.
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

vi.mock('../../../../config/env', () => ({
  env: {
    systemUserId: '000000000000000000000000',
    salaryRetention: { enabled: true, payrollYears: 8, wageLedgerYears: 10 },
  },
}));

import { Types } from 'mongoose';
import { SalaryRetentionPurgeCron } from '../salary-retention-purge.cron';

const singleFlight = {
  runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
} as any;

function model(deletedCount = 0) {
  return { deleteMany: vi.fn().mockResolvedValue({ deletedCount }) } as any;
}

function build(opts: { salaryDeleted?: number; paymentDeleted?: number; audit?: any }) {
  const wsOid = new Types.ObjectId();
  const workspaceModel = {
    find: () => ({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve([{ _id: wsOid, name: 'WS' }]) }),
      }),
    }),
  } as any;
  const payrollConfigModel = {
    findOne: () => ({ select: () => ({ lean: () => ({ exec: () => Promise.resolve(null) }) }) }),
  } as any;
  const cron = new SalaryRetentionPurgeCron(
    workspaceModel,
    payrollConfigModel,
    model(opts.salaryDeleted ?? 0), // salary (wage window)
    model(opts.paymentDeleted ?? 0), // payment (payroll window)
    model(),
    model(),
    model(),
    model(),
    model(),
    model(),
    model(),
    model(),
    model(),
    model(), // cashLedger
    singleFlight,
    opts.audit,
  );
  return cron;
}

describe('SalaryRetentionPurgeCron — Phase 7 audit-at-purge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('audits the purge with class counts, basis and window cutoffs when rows were deleted', async () => {
    const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const cron = build({ salaryDeleted: 2, paymentDeleted: 3, audit });

    await cron.handlePurge();

    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    const ev = audit.logEvent.mock.calls[0][0];
    expect(ev.action).toBe('retention_purged');
    expect(ev.module).toBe('salary');
    expect(ev.meta.totalDeleted).toBe(5);
    expect(ev.meta.collections.salary).toBe(2);
    expect(ev.meta.collections.payment).toBe(3);
    expect(ev.meta.basis).toBe('statutory-retention-floor');
    expect(ev.meta.windowYears.wage).toBe(10);
    expect(ev.meta.cutoffs.wage).toBeDefined();
  });

  it('does NOT audit when the workspace had nothing to purge', async () => {
    const audit = { logEvent: vi.fn() };
    const cron = build({ salaryDeleted: 0, paymentDeleted: 0, audit });

    await cron.handlePurge();

    expect(audit.logEvent).not.toHaveBeenCalled();
  });

  it('never throws when the audit write fails (best-effort, purge already done)', async () => {
    const audit = { logEvent: vi.fn().mockRejectedValue(new Error('audit down')) };
    const cron = build({ salaryDeleted: 1, paymentDeleted: 0, audit });

    await expect(cron.handlePurge()).resolves.toBeUndefined();
  });
});
