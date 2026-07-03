/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workspace retention purge — ENABLED path (§3e / AC-1.4).
 *
 * Proves, with the flag forced ON:
 *   - the cutoff is anchored on `deletedAt` and uses max(env, floor) grace;
 *   - the updateMany filter targets ONLY soft-deleted rows past the cutoff;
 *   - the Bucket-C scrub clears branding/prefs/policy/etc. and NEVER touches a
 *     Bucket-A identity field (name / workspaceCode / designations) or any
 *     statutory data;
 *   - the grace FLOOR wins when the env value is below it.
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

// Force ON, with an env grace BELOW the 30-day floor so we can assert the floor wins.
vi.mock('../../../../config/env', () => ({
  env: {
    workspaceRetention: { enabled: true, graceDays: 5 },
  },
}));

import {
  WorkspaceRetentionPurgeCron,
  WORKSPACE_RETENTION_GRACE_FLOOR_DAYS,
} from '../workspace-retention-purge.cron';

describe('WorkspaceRetentionPurgeCron — enabled path (AC-1.4)', () => {
  let workspaceModel: any;
  let singleFlight: any;
  let updateManyArgs: { filter: any; update: any } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    updateManyArgs = null;
    workspaceModel = {
      updateMany: vi.fn().mockImplementation((filter: any, update: any) => {
        updateManyArgs = { filter, update };
        return Promise.resolve({ modifiedCount: 1 });
      }),
    };
    singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    };
  });

  it('scrubs Bucket-C on soft-deleted rows past the grace floor; never identity/statutory', async () => {
    const before = Date.now();
    const cron = new WorkspaceRetentionPurgeCron(workspaceModel, singleFlight);
    await cron.handlePurge();
    const after = Date.now();

    expect(singleFlight.runExclusive).toHaveBeenCalledTimes(1);
    expect(workspaceModel.updateMany).toHaveBeenCalledTimes(1);
    expect(updateManyArgs).not.toBeNull();

    const { filter, update } = updateManyArgs;

    // Only soft-deleted rows are eligible.
    expect(filter.isDeleted).toBe(true);

    // Cutoff anchored on deletedAt, using the FLOOR (30d) not the env value (5d).
    const cutoff: Date = filter.deletedAt.$lt;
    const floorMs = WORKSPACE_RETENTION_GRACE_FLOOR_DAYS * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - floorMs - 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - floorMs + 1000);

    // Bucket-C fields are scrubbed.
    expect(update.$unset).toHaveProperty('branding');
    expect(update.$unset).toHaveProperty('exportPreferences');
    expect(update.$unset).toHaveProperty('notificationPolicy');
    expect(update.$unset).toHaveProperty('selfServiceConfig');
    expect(update.$unset).toHaveProperty('partyIntelligence');
    expect(update.$unset).toHaveProperty('storageUsage');
    expect(update.$unset).toHaveProperty('appLockIdleMs');
    expect(update.$unset).toHaveProperty('emailConfig.smtpConfig.host');
    expect(update.$set.autoAcceptKnownInvites).toBe(false);
    expect(update.$set.kioskEnabled).toBe(false);

    // Bucket-A identity + statutory fields must NEVER be in the scrub.
    const unsetKeys = Object.keys(update.$unset);
    const setKeys = Object.keys(update.$set);
    for (const k of [
      'name',
      'workspaceCode',
      'designations',
      'bankAccounts',
      'ownerId',
      'employeeCodeSettings',
      'attendanceSettings',
      'isDeleted',
      'deletedAt',
    ]) {
      expect(unsetKeys).not.toContain(k);
      expect(setKeys).not.toContain(k);
    }
    // The credential itself is NOT scrubbed here (already nulled at delete time).
    expect(update.$unset).not.toHaveProperty('emailConfig.smtpConfig.pass');
    expect(update.$unset).not.toHaveProperty('kioskTokenHash');
  });
});
