/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Finance/Bills retention purge — ENABLED path (spec AC-1.8 / C1-D / D5).
 *
 * Pins the destructive behaviour:
 *   - the 8-year HARD floor wins even when the env value is set BELOW it
 *     (financeYears=1 still clamps to 8 → AC-1.8);
 *   - ONLY soft-deleted rows (isDeleted:true) older than the window are erased,
 *     anchored on deletedAt — an active bill is never touched;
 *   - the query is workspace-scoped (no cross-workspace purge);
 *   - it ONLY ever deletes the `bills` collection — there is no model for any
 *     LedgerEntry / posted voucher in this cron (C1-D / D5 structural guard).
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

// Enabled, with an env value DELIBERATELY below the 8y floor to prove the
// constant floor wins.
vi.mock('../../../../config/env', () => ({
  env: { billsRetention: { enabled: true, financeYears: 1 } },
}));

import {
  BillsRetentionPurgeCron,
  STATUTORY_FINANCE_FLOOR_YEARS,
} from '../bills-retention-purge.cron';

describe('BillsRetentionPurgeCron — enabled path + statutory floor (AC-1.8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clamps the window to the 8y floor and deletes ONLY soft-deleted rows past it', async () => {
    expect(STATUTORY_FINANCE_FLOOR_YEARS).toBe(8);

    // Use a valid 24-char hex ws id — process() casts it to ObjectId for the
    // deleteMany filter, so a non-ObjectId would throw + be swallowed.
    const workspaceModel: any = {
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockReturnValue({
            exec: vi.fn().mockResolvedValue([{ _id: '6a2f26baca75116b4eee1c86', name: 'A' }]),
          }),
        }),
      }),
    };
    const billModel: any = {
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
    };
    const singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    } as any;

    const cron = new BillsRetentionPurgeCron(workspaceModel, billModel, singleFlight);
    await cron.handlePurge();

    expect(billModel.deleteMany).toHaveBeenCalledTimes(1);
    const filter = billModel.deleteMany.mock.calls[0][0];
    // ONLY soft-deleted rows, anchored on deletedAt, scoped to the workspace.
    expect(filter.isDeleted).toBe(true);
    expect(filter.deletedAt).toHaveProperty('$lt');
    expect(filter.workspaceId).toBeDefined();

    // The cutoff must be ~8 years ago (the floor), NOT 1 year (the env value).
    const cutoff: Date = filter.deletedAt.$lt;
    const yearsAgo = (Date.now() - cutoff.getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(yearsAgo).toBeGreaterThan(7.5);
    expect(yearsAgo).toBeLessThan(8.5);
  });
});
