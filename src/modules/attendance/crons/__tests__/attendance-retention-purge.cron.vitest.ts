/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attendance retention purge — OQ-A4 safety + floor coverage. Two suites:
 *   1. ENABLED path: the 10-year muster floor is enforced even when the env
 *      value is set below it, and the dispatch (Bucket-D) rows use their own
 *      1-year window.
 *   2. The sibling `.disabled.vitest.ts` proves the OFF-by-default short-circuit.
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

// ENABLED, with a too-short env value to prove the HARD floor wins.
vi.mock('../../../../config/env', () => ({
  env: {
    attendanceRetention: { enabled: true, musterYears: 2, dispatchYears: 1 },
  },
}));

import {
  AttendanceRetentionPurgeCron,
  STATUTORY_MUSTER_FLOOR_YEARS,
} from '../attendance-retention-purge.cron';

const WS = '5f8d04b3b54764421b7156aa';

function deleteModel(deletedCount = 0) {
  return { deleteMany: vi.fn().mockResolvedValue({ deletedCount }) } as any;
}

function makeCron(opts: { attendance?: any; event?: any; dispatch?: any } = {}) {
  const workspaceModel = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: WS, name: 'WS A' }]),
    }),
  } as any;
  const attendance = opts.attendance ?? deleteModel(3);
  const event = opts.event ?? deleteModel(5);
  const dispatch = opts.dispatch ?? deleteModel(1);
  const singleFlight = {
    runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
  } as any;
  const cron = new AttendanceRetentionPurgeCron(
    workspaceModel,
    attendance,
    event,
    dispatch,
    singleFlight,
  );
  return { cron, workspaceModel, attendance, event, dispatch, singleFlight };
}

describe('AttendanceRetentionPurgeCron — enabled path (OQ-A4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enters single-flight and purges all three collections per workspace', async () => {
    const { cron, attendance, event, dispatch, singleFlight } = makeCron();
    await cron.handlePurge();
    expect(singleFlight.runExclusive).toHaveBeenCalledTimes(1);
    expect(attendance.deleteMany).toHaveBeenCalledTimes(1);
    expect(event.deleteMany).toHaveBeenCalledTimes(1);
    expect(dispatch.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('clamps the muster window UP to the 10-year HARD floor even when env says 2', async () => {
    const { cron, attendance, event } = makeCron();
    const now = Date.now();
    await cron.handlePurge();

    // The cutoff passed to Attendance.deleteMany must be ~10 years ago, NOT 2.
    const attFilter = attendance.deleteMany.mock.calls[0][0];
    const cutoffMs = (attFilter.updatedAt.$lt as Date).getTime();
    const yearsAgo = (now - cutoffMs) / (365.25 * 24 * 3600 * 1000);
    expect(Math.round(yearsAgo)).toBe(STATUTORY_MUSTER_FLOOR_YEARS);

    // Events anchor on `timestamp` (no updatedAt on the append-only schema).
    const evtFilter = event.deleteMany.mock.calls[0][0];
    expect(evtFilter.timestamp).toBeDefined();
    expect(evtFilter.updatedAt).toBeUndefined();
  });

  it('purges DefaulterAlertDispatch on its own 1-year createdAt window', async () => {
    const { cron, dispatch } = makeCron();
    const now = Date.now();
    await cron.handlePurge();
    const filter = dispatch.deleteMany.mock.calls[0][0];
    const cutoffMs = (filter.createdAt.$lt as Date).getTime();
    const yearsAgo = (now - cutoffMs) / (365.25 * 24 * 3600 * 1000);
    expect(Math.round(yearsAgo)).toBe(1);
  });

  it('continues past a per-workspace error (one failure does not abort the run)', async () => {
    const event = { deleteMany: vi.fn().mockRejectedValue(new Error('mongo down')) } as any;
    const { cron } = makeCron({ event });
    await expect(cron.handlePurge()).resolves.toBeUndefined();
  });
});
