/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workspace retention purge — ENV flag OFF test (§3e / AC-1.4 safety gate).
 *
 * The Bucket-C scrub MUST default to OFF. With RUN_RETENTION_PURGE_ON_SCHEDULE
 * unset (or false), handlePurge() must exit before touching any data. This test
 * mocks the env to disabled and verifies no updateMany is called and the
 * single-flight is never even entered.
 *
 * The enabled-path (grace floor + Bucket-C field set) is covered by the sibling
 * test workspace-retention-purge.cron.vitest.ts which forces enabled:true.
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

// The env must be mocked BEFORE importing the cron class (vitest hoists vi.mock).
vi.mock('../../../../config/env', () => ({
  env: {
    workspaceRetention: { enabled: false, graceDays: 90 },
  },
}));

import { WorkspaceRetentionPurgeCron } from '../workspace-retention-purge.cron';

describe('WorkspaceRetentionPurgeCron — disabled by default (AC-1.4)', () => {
  let workspaceModel: any;
  let singleFlight: any;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceModel = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: vi.fn(),
    };
    singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    };
  });

  it('skips updateMany when RUN_RETENTION_PURGE_ON_SCHEDULE is false', async () => {
    const cron = new WorkspaceRetentionPurgeCron(workspaceModel, singleFlight);
    await cron.handlePurge();

    // No data write and the single-flight must NOT be entered (short-circuit).
    expect(workspaceModel.updateMany).not.toHaveBeenCalled();
    expect(singleFlight.runExclusive).not.toHaveBeenCalled();
  });
});
