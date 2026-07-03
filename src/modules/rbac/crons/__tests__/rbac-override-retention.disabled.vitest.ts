/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RBAC override retention cleaner — ENV flag OFF test (RBAC hardening Pillar 1).
 *
 * The cleaner MUST default to OFF. With RUN_RETENTION_PURGE_ON_SCHEDULE unset
 * (or false), handlePurge() must exit before touching any data — no updateMany,
 * not even the single-flight is entered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

// Env mocked BEFORE importing the cron so it captures the disabled value.
vi.mock('../../../../config/env', () => ({
  env: { rbacRetention: { enabled: false, overrideKeepYears: 1 } },
}));

import { RbacOverrideRetentionCron } from '../rbac-override-retention.cron';

function model() {
  return {
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    find: vi.fn(),
  } as any;
}

describe('RbacOverrideRetentionCron — cleaner disabled by default (Pillar 1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips all updateMany calls when RUN_RETENTION_PURGE_ON_SCHEDULE is false', async () => {
    const workspaceModel = model();
    const teamMemberModel = model();
    const singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    } as any;

    const cron = new RbacOverrideRetentionCron(workspaceModel, teamMemberModel, singleFlight);
    await cron.handlePurge();

    expect(workspaceModel.find).not.toHaveBeenCalled();
    expect(teamMemberModel.updateMany).not.toHaveBeenCalled();
    expect(singleFlight.runExclusive).not.toHaveBeenCalled();
  });
});
