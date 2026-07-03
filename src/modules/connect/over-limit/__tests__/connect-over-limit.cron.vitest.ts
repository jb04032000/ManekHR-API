/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The @Cron decorator must be a no-op so importing the cron class does not try to
// register a real schedule (mirrors the other *-single-flight cron specs).
vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: {},
}));

import { ConnectOverLimitReconcileCron } from '../connect-over-limit.cron';
import { CronJobKey } from '../../../../common/constants/cron.constants';

/** Single-flight lock double: records the jobKey + runs the body only when granted. */
function lock(grant: boolean) {
  const calls: string[] = [];
  return {
    calls,
    svc: {
      runExclusive: vi.fn(async (jobKey: string, _p: string, fn: () => Promise<unknown>) => {
        calls.push(jobKey);
        if (!grant) return { ran: false };
        return { ran: true, result: await fn() };
      }),
    } as any,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('ConnectOverLimitReconcileCron', () => {
  it('claims its single-flight key and reconciles every distinct owner', async () => {
    const reconcileUser = vi.fn().mockResolvedValue([]);
    const over = {
      distinctOwnerIds: vi.fn().mockResolvedValue(['u1', 'u2', 'u3']),
      reconcileUser,
    } as any;
    const l = lock(true);
    const cron = new ConnectOverLimitReconcileCron(over, l.svc);

    await cron.run();

    // Wrapped in the single-flight lock under the canonical job key.
    expect(l.calls).toEqual([CronJobKey.CONNECT_OVER_LIMIT_RECONCILE]);
    // Each owner reconciled exactly once.
    expect(reconcileUser).toHaveBeenCalledTimes(3);
    expect(reconcileUser.mock.calls.map((c) => c[0])).toEqual(['u1', 'u2', 'u3']);
  });

  it('does not reconcile when another worker holds the lock', async () => {
    const reconcileUser = vi.fn();
    const over = {
      distinctOwnerIds: vi.fn().mockResolvedValue(['u1']),
      reconcileUser,
    } as any;
    const l = lock(false);
    const cron = new ConnectOverLimitReconcileCron(over, l.svc);

    await cron.run();

    expect(l.calls).toEqual([CronJobKey.CONNECT_OVER_LIMIT_RECONCILE]);
    expect(reconcileUser).not.toHaveBeenCalled();
  });

  it('isolates a per-owner failure so the sweep still finishes the rest', async () => {
    const reconcileUser = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    const over = {
      distinctOwnerIds: vi.fn().mockResolvedValue(['u1', 'u2', 'u3']),
      reconcileUser,
    } as any;
    const cron = new ConnectOverLimitReconcileCron(over, lock(true).svc);

    const processed = await cron.tick();

    // u2 threw but u1 + u3 still processed (2 of 3).
    expect(reconcileUser).toHaveBeenCalledTimes(3);
    expect(processed).toBe(2);
  });
});
