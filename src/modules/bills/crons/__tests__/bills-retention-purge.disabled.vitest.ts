/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Finance/Bills retention purge — ENV flag OFF test (spec AC-1.4).
 *
 * The purge job MUST default to OFF. With RUN_RETENTION_PURGE_ON_SCHEDULE unset
 * (or false), handlePurge() must exit before touching any data — no deleteMany,
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
  env: { billsRetention: { enabled: false, financeYears: 8 } },
}));

import { BillsRetentionPurgeCron } from '../bills-retention-purge.cron';

function model() {
  return {
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    find: vi.fn(),
  } as any;
}

describe('BillsRetentionPurgeCron — purge disabled by default (AC-1.4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips all deleteMany calls when RUN_RETENTION_PURGE_ON_SCHEDULE is false', async () => {
    const workspaceModel = model();
    const billModel = model();
    const singleFlight = {
      runExclusive: vi.fn(async (_k: string, _p: string, fn: () => Promise<unknown>) => fn()),
    } as any;

    const cron = new BillsRetentionPurgeCron(workspaceModel, billModel, singleFlight);
    await cron.handlePurge();

    expect(workspaceModel.find).not.toHaveBeenCalled();
    expect(billModel.deleteMany).not.toHaveBeenCalled();
    expect(singleFlight.runExclusive).not.toHaveBeenCalled();
  });
});
