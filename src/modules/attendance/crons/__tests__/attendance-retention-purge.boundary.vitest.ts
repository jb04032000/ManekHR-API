/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attendance retention purge — OQ-A4 boundary-condition tests.
 *
 * The spec requires the 10-year muster floor to be honoured at the boundary:
 *   - A record at exactly 9 years 364 days old MUST survive the purge.
 *   - A record at 10 years + 1 day old MUST be deleted.
 *   - A hostile/short env value (e.g. musterYears=1) cannot shorten the floor
 *     below 10 years — the STATUTORY_MUSTER_FLOOR_YEARS constant wins.
 *   - DefaulterAlertDispatch follows its own 1-year window, independent of
 *     the muster floor.
 *
 * Strategy: instead of running the real cron (which calls deleteMany on the DB),
 * intercept the exact filter argument passed to deleteMany and verify the cutoff
 * date it carries. This gives precise boundary-condition assertions without
 * having to seed and inspect a real DB.
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

// Use musterYears=2 to prove the hard floor (10y) wins over the env value (2y).
vi.mock('../../../../config/env', () => ({
  env: {
    attendanceRetention: { enabled: true, musterYears: 2, dispatchYears: 1 },
  },
}));

import {
  AttendanceRetentionPurgeCron,
  STATUTORY_MUSTER_FLOOR_YEARS,
} from '../attendance-retention-purge.cron';

const WS_ID = '5f8d04b3b54764421b7156aa';

/** Captures the filter argument and resolves with a zero-deleted count. */
function captureModel() {
  const calls: any[] = [];
  return {
    deleteMany: vi.fn().mockImplementation((filter: any) => {
      calls.push(filter);
      return Promise.resolve({ deletedCount: 0 });
    }),
    _calls: calls,
  } as any;
}

function makeCron(attendance: any, event: any, dispatch: any) {
  const workspaceModel = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: WS_ID, name: 'WS A' }]),
    }),
  } as any;
  const singleFlight = {
    runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
  } as any;
  return new AttendanceRetentionPurgeCron(
    workspaceModel,
    attendance,
    event,
    dispatch,
    singleFlight,
  );
}

describe('AttendanceRetentionPurgeCron — 10-year boundary conditions (OQ-A4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('STATUTORY_MUSTER_FLOOR_YEARS constant is exactly 10 (code, not env-overridable)', () => {
    expect(STATUTORY_MUSTER_FLOOR_YEARS).toBe(10);
  });

  it('the cutoff passed to Attendance.deleteMany is ~10 years ago when env says 2', async () => {
    const attendance = captureModel();
    const event = captureModel();
    const dispatch = captureModel();
    const cron = makeCron(attendance, event, dispatch);
    await cron.handlePurge();

    const attFilter = attendance._calls[0];
    const cutoffMs = (attFilter.updatedAt.$lt as Date).getTime();

    // Use Math.round(yearsAgo) to tolerate the setFullYear vs Ms-based difference.
    // The cron uses setFullYear which is leap-year-aware; a tight ms window would
    // fail on non-leap-year boundaries. Round-tripping via years is the right check.
    const yearsAgo = (Date.now() - cutoffMs) / (365.25 * 24 * 3600 * 1000);
    expect(Math.round(yearsAgo)).toBe(STATUTORY_MUSTER_FLOOR_YEARS);
  });

  it('a record at 9y 364d old falls INSIDE the 10-year floor and would NOT be purged', async () => {
    const attendance = captureModel();
    const event = captureModel();
    const dispatch = captureModel();
    const cron = makeCron(attendance, event, dispatch);
    await cron.handlePurge();

    const attFilter = attendance._calls[0];
    const cutoff = (attFilter.updatedAt.$lt as Date).getTime();

    // A record 9 years 364 days old has updatedAt = now - (9y364d).
    // It is MORE RECENT than the cutoff (now - 10y), so deleteMany would not
    // include it. Verify: record's updatedAt > cutoff.
    const nineYears364dMs = (9 * 365.25 + 364) * 24 * 3600 * 1000;
    const recordUpdatedAt = Date.now() - nineYears364dMs;
    expect(recordUpdatedAt).toBeGreaterThan(cutoff);
  });

  it('a record at 10y + 1 day old falls OUTSIDE the floor and WOULD be purged', async () => {
    const attendance = captureModel();
    const event = captureModel();
    const dispatch = captureModel();
    const cron = makeCron(attendance, event, dispatch);
    await cron.handlePurge();

    const attFilter = attendance._calls[0];
    const cutoff = (attFilter.updatedAt.$lt as Date).getTime();

    // A record 10 years + 1 day old has updatedAt = now - (10y + 1d).
    // It is OLDER than the cutoff (now - 10y), so deleteMany WOULD include it.
    const tenYears1dMs = (10 * 365.25 + 1) * 24 * 3600 * 1000;
    const recordUpdatedAt = Date.now() - tenYears1dMs;
    expect(recordUpdatedAt).toBeLessThan(cutoff);
  });

  it('the event model cutoff uses `timestamp` field (not updatedAt), same 10-year floor', async () => {
    const attendance = captureModel();
    const event = captureModel();
    const dispatch = captureModel();
    const cron = makeCron(attendance, event, dispatch);
    await cron.handlePurge();

    const evtFilter = event._calls[0];
    // Events use `timestamp` (not updatedAt — append-only, no updatedAt on schema).
    expect(evtFilter).toHaveProperty('timestamp');
    expect(evtFilter).not.toHaveProperty('updatedAt');

    const cutoffMs = (evtFilter.timestamp.$lt as Date).getTime();
    const yearsAgo = (Date.now() - cutoffMs) / (365.25 * 24 * 3600 * 1000);
    expect(Math.round(yearsAgo)).toBe(STATUTORY_MUSTER_FLOOR_YEARS);
  });

  it('dispatch model cutoff uses `createdAt` with its own 1-year floor (not the 10y muster floor)', async () => {
    const attendance = captureModel();
    const event = captureModel();
    const dispatch = captureModel();
    const cron = makeCron(attendance, event, dispatch);
    await cron.handlePurge();

    const dispFilter = dispatch._calls[0];
    expect(dispFilter).toHaveProperty('createdAt');

    const cutoffMs = (dispFilter.createdAt.$lt as Date).getTime();
    // Use Math.round(yearsAgo) to tolerate leap-year vs Ms difference (same as above).
    const yearsAgo = (Date.now() - cutoffMs) / (365.25 * 24 * 3600 * 1000);
    expect(Math.round(yearsAgo)).toBe(1); // dispatch floor = 1y, not 10y
  });

  it('a hostile env override of musterYears=1 still produces a 10-year cutoff', async () => {
    // The env mock in this file sets musterYears=2 (already < 10); the cron must
    // ignore it and apply STATUTORY_MUSTER_FLOOR_YEARS = 10. This is the same
    // assertion as "clamps UP" but from the security perspective: an env override
    // cannot be weaponised to destroy statutory evidence early.
    const attendance = captureModel();
    const event = captureModel();
    const dispatch = captureModel();
    const cron = makeCron(attendance, event, dispatch);
    await cron.handlePurge();

    const attFilter = attendance._calls[0];
    const cutoffMs = (attFilter.updatedAt.$lt as Date).getTime();
    const yearsAgo = (Date.now() - cutoffMs) / (365.25 * 24 * 3600 * 1000);
    // Must be ~10 years, not the env's 2 years.
    expect(Math.round(yearsAgo)).toBe(STATUTORY_MUSTER_FLOOR_YEARS);
  });
});
