/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Attendance retention purge — ENV flag OFF test (OQ-A4 safety gate).
 *
 * The purge job MUST default to OFF (it shares the master
 * RUN_RETENTION_PURGE_ON_SCHEDULE switch). With the flag false, handlePurge()
 * must exit before touching any data or entering the single-flight.
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
    attendanceRetention: { enabled: false, musterYears: 10, dispatchYears: 1 },
  },
}));

import { AttendanceRetentionPurgeCron } from '../attendance-retention-purge.cron';

function deleteModel() {
  return { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }), find: vi.fn() } as any;
}

describe('AttendanceRetentionPurgeCron — purge disabled by default (OQ-A4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips all work when RUN_RETENTION_PURGE_ON_SCHEDULE is false', async () => {
    const workspaceModel = deleteModel();
    const attendance = deleteModel();
    const event = deleteModel();
    const dispatch = deleteModel();
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

    await cron.handlePurge();

    expect(workspaceModel.find).not.toHaveBeenCalled();
    expect(attendance.deleteMany).not.toHaveBeenCalled();
    expect(event.deleteMany).not.toHaveBeenCalled();
    expect(dispatch.deleteMany).not.toHaveBeenCalled();
    expect(singleFlight.runExclusive).not.toHaveBeenCalled();
  });
});
