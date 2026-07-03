/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion lifecycle crons (Phase 2, plan §6):
 *   - handleFinalize: single-flight wraps finalizeDuePending and runs DAILY
 *     REGARDLESS of RUN_RETENTION_PURGE_ON_SCHEDULE (the personal-data Day-30
 *     guarantee is never behind the OFF-by-default bulk switch).
 *   - handleReminder: single-flight wraps the ~Day-25 reminder sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountDeletionCron } from '../account-deletion.cron';

describe('AccountDeletionCron (Phase 2)', () => {
  let finalizeService: { finalizeDuePending: ReturnType<typeof vi.fn> };
  let accountDeletionService: { remindDuePending: ReturnType<typeof vi.fn> };
  let singleFlight: { runExclusive: ReturnType<typeof vi.fn> };
  let cron: AccountDeletionCron;

  beforeEach(() => {
    finalizeService = { finalizeDuePending: vi.fn().mockResolvedValue({ scanned: 0, purged: 0 }) };
    accountDeletionService = {
      remindDuePending: vi.fn().mockResolvedValue({ scanned: 0, reminded: 0 }),
    };
    // runExclusive immediately invokes fn (i.e. this worker won the occurrence).
    singleFlight = {
      runExclusive: vi.fn(async (_key: string, _period: string, fn: () => Promise<unknown>) => {
        const result = await fn();
        return { ran: true, result };
      }),
    };
    cron = new AccountDeletionCron(
      finalizeService as any,
      accountDeletionService as any,
      singleFlight as any,
    );
  });

  it('finalize cron runs the Day-30 sweep under a single-flight lock (no env gate)', async () => {
    await cron.handleFinalize();

    expect(singleFlight.runExclusive).toHaveBeenCalledTimes(1);
    expect(singleFlight.runExclusive.mock.calls[0][0]).toBe('account_deletion.finalize');
    expect(finalizeService.finalizeDuePending).toHaveBeenCalledTimes(1);
  });

  it('reminder cron runs the ~Day-25 sweep under a single-flight lock', async () => {
    await cron.handleReminder();

    expect(singleFlight.runExclusive).toHaveBeenCalledTimes(1);
    expect(singleFlight.runExclusive.mock.calls[0][0]).toBe('account_deletion.reminder');
    expect(accountDeletionService.remindDuePending).toHaveBeenCalledTimes(1);
  });
});
