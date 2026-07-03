/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RBAC override retention cleaner — ENABLED path (RBAC hardening Pillar 1).
 *
 * Pins the behaviour:
 *   - the 1-year HARD floor wins even when the env value is set BELOW it
 *     (overrideKeepYears=0 still clamps to 1);
 *   - ONLY removed members (isDeleted:true) past the window are scrubbed,
 *     anchored on deletedAt — an active member is never touched;
 *   - only members still carrying an override are matched ($or non-empty);
 *   - the write is a SCRUB (arrays → []), never a delete;
 *   - the query is workspace-scoped (no cross-workspace clear);
 *   - it ONLY ever touches the `team_members` collection — there is no model for
 *     any Role or audit row in this cron.
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

// Enabled, with an env value DELIBERATELY below the 1y floor to prove the
// constant floor wins.
vi.mock('../../../../config/env', () => ({
  env: { rbacRetention: { enabled: true, overrideKeepYears: 0 } },
}));

import {
  RbacOverrideRetentionCron,
  RBAC_OVERRIDE_KEEP_FLOOR_YEARS,
} from '../rbac-override-retention.cron';

describe('RbacOverrideRetentionCron — enabled path + keep-window floor (Pillar 1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clamps the window to the 1y floor and scrubs ONLY removed members past it', async () => {
    expect(RBAC_OVERRIDE_KEEP_FLOOR_YEARS).toBe(1);

    // Use a valid 24-char hex ws id — process() casts it to ObjectId for the
    // updateMany filter, so a non-ObjectId would throw + be swallowed.
    const workspaceModel: any = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([{ _id: '6a2f26baca75116b4eee1c86', name: 'A' }]),
          }),
        }),
      }),
    };
    const teamMemberModel: any = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
    };
    const singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    } as any;

    const cron = new RbacOverrideRetentionCron(workspaceModel, teamMemberModel, singleFlight);
    await cron.handlePurge();

    expect(teamMemberModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = teamMemberModel.updateMany.mock.calls[0];

    // ONLY removed members, anchored on deletedAt, scoped to the workspace.
    expect(filter.isDeleted).toBe(true);
    expect(filter.deletedAt).toHaveProperty('$lt');
    expect(filter.workspaceId).toBeDefined();
    // Only members still carrying at least one override are matched.
    expect(Array.isArray(filter.$or)).toBe(true);
    expect(filter.$or).toHaveLength(2);

    // SCRUB, not delete: both override arrays are zeroed.
    expect(update.$set.permissionOverrides).toEqual([]);
    expect(update.$set.permissionPathOverrides).toEqual([]);

    // The cutoff must be ~1 year ago (the floor), NOT 0 years (the env value).
    const cutoff: Date = filter.deletedAt.$lt;
    const yearsAgo = (Date.now() - cutoff.getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(yearsAgo).toBeGreaterThan(0.9);
    expect(yearsAgo).toBeLessThan(1.1);
  });
});
