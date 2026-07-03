/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/**
 * Phase 7 audit-at-purge (ACCOUNT-DELETION-AND-DPDP-PLAN.md §8): the attendance
 * retention purge must leave a grievance-trail audit per workspace it purges —
 * the muster/event/dispatch class counts, the basis, and the elapsed-window
 * cutoffs. Best-effort: fires only when rows were deleted; an audit failure never
 * aborts the (already-completed) purge.
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
    attendanceRetention: { enabled: true, musterYears: 10, dispatchYears: 1 },
  },
}));

import { AttendanceRetentionPurgeCron } from '../attendance-retention-purge.cron';

const WS = '5f8d04b3b54764421b7156aa';
const singleFlight = {
  runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
} as any;

function model(deletedCount = 0) {
  return { deleteMany: vi.fn().mockResolvedValue({ deletedCount }) } as any;
}

function build(opts: { attendance?: number; event?: number; dispatch?: number; audit?: any }) {
  const workspaceModel = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: WS, name: 'WS A' }]),
    }),
  } as any;
  return new AttendanceRetentionPurgeCron(
    workspaceModel,
    model(opts.attendance ?? 0),
    model(opts.event ?? 0),
    model(opts.dispatch ?? 0),
    singleFlight,
    opts.audit,
  );
}

describe('AttendanceRetentionPurgeCron — Phase 7 audit-at-purge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('audits the purge with class counts, basis and the muster cutoff when rows were deleted', async () => {
    const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    const cron = build({ attendance: 4, event: 6, dispatch: 1, audit });

    await cron.handlePurge();

    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    const ev = audit.logEvent.mock.calls[0][0];
    expect(ev.action).toBe('retention_purged');
    expect(ev.module).toBe('attendance');
    expect(ev.meta.totalDeleted).toBe(11);
    expect(ev.meta.collections.attendance).toBe(4);
    expect(ev.meta.collections.attendanceEvent).toBe(6);
    expect(ev.meta.windowYears.muster).toBe(10);
    expect(ev.meta.cutoffs.muster).toBeDefined();
  });

  it('does NOT audit when the workspace had nothing to purge', async () => {
    const audit = { logEvent: vi.fn() };
    const cron = build({ attendance: 0, event: 0, dispatch: 0, audit });

    await cron.handlePurge();

    expect(audit.logEvent).not.toHaveBeenCalled();
  });

  it('never throws when the audit write fails (best-effort, purge already done)', async () => {
    const audit = { logEvent: vi.fn().mockRejectedValue(new Error('audit down')) };
    const cron = build({ attendance: 1, audit });

    await expect(cron.handlePurge()).resolves.toBeUndefined();
  });
});
