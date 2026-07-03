/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The @Cron decorator must be a no-op so importing the cron class does not try to
// register a real schedule (mirrors connect-over-limit.cron.vitest.ts).
vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: {},
}));

import { ErpMemberCapReconcileCron } from '../erp-member-cap.cron';
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

describe('ErpMemberCapReconcileCron', () => {
  it('claims its single-flight key and reconciles every candidate workspace', async () => {
    const reconcileWorkspace = vi.fn().mockResolvedValue(undefined);
    const memberCap = {
      candidateWorkspaceIds: vi.fn().mockResolvedValue(['w1', 'w2', 'w3']),
      reconcileWorkspace,
    } as any;
    const l = lock(true);
    const cron = new ErpMemberCapReconcileCron(memberCap, l.svc);

    await cron.run();

    // Wrapped in the single-flight lock under the canonical job key.
    expect(l.calls).toEqual([CronJobKey.ERP_MEMBER_CAP_RECONCILE]);
    // Each workspace reconciled exactly once.
    expect(reconcileWorkspace).toHaveBeenCalledTimes(3);
    expect(reconcileWorkspace.mock.calls.map((c) => c[0])).toEqual(['w1', 'w2', 'w3']);
  });

  it('does not reconcile when another worker holds the lock', async () => {
    const reconcileWorkspace = vi.fn();
    const memberCap = {
      candidateWorkspaceIds: vi.fn().mockResolvedValue(['w1']),
      reconcileWorkspace,
    } as any;
    const l = lock(false);
    const cron = new ErpMemberCapReconcileCron(memberCap, l.svc);

    await cron.run();

    expect(l.calls).toEqual([CronJobKey.ERP_MEMBER_CAP_RECONCILE]);
    expect(reconcileWorkspace).not.toHaveBeenCalled();
  });

  it('isolates a per-workspace failure so the sweep still finishes the rest', async () => {
    const reconcileWorkspace = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const memberCap = {
      candidateWorkspaceIds: vi.fn().mockResolvedValue(['w1', 'w2', 'w3']),
      reconcileWorkspace,
    } as any;
    const cron = new ErpMemberCapReconcileCron(memberCap, lock(true).svc);

    const processed = await cron.tick();

    // w2 threw but w1 + w3 still processed (2 of 3).
    expect(reconcileWorkspace).toHaveBeenCalledTimes(3);
    expect(processed).toBe(2);
  });
});
