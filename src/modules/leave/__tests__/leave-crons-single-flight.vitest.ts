/* eslint-disable @typescript-eslint/no-explicit-any */
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

import { LeaveAccrualCron } from '../leave-accrual.cron';
import { LeaveMaintenanceCron } from '../leave-maintenance.cron';
import { CronJobKey } from '../../../common/constants/cron.constants';

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

const postHog = { capture: vi.fn() } as any;

describe('leave crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('LeaveAccrualCron runs the accrual service on claim', async () => {
    const l = lock(true);
    const accrual = {
      accrueAllWorkspaces: vi.fn().mockResolvedValue({
        workspacesScanned: 0,
        membersScanned: 0,
        entriesPosted: 0,
        errors: [],
      }),
    } as any;
    await new LeaveAccrualCron(accrual, postHog, l.svc).run();
    expect(l.calls[0]).toBe(CronJobKey.LEAVE_ACCRUAL);
    expect(accrual.accrueAllWorkspaces).toHaveBeenCalledOnce();
  });

  it('LeaveAccrualCron does nothing when the claim is held', async () => {
    const l = lock(false);
    const accrual = { accrueAllWorkspaces: vi.fn() } as any;
    await new LeaveAccrualCron(accrual, postHog, l.svc).run();
    expect(l.calls[0]).toBe(CronJobKey.LEAVE_ACCRUAL);
    expect(accrual.accrueAllWorkspaces).not.toHaveBeenCalled();
  });

  it('comp-off expiry runs the service on claim, skips when held', async () => {
    const compOff = {
      expireCompOffLots: vi.fn().mockResolvedValue({ lotsExpired: 0, daysExpired: 0, errors: [] }),
    } as any;
    const yearEnd = { runYearEndAllWorkspaces: vi.fn() } as any;

    const granted = lock(true);
    await new LeaveMaintenanceCron(compOff, yearEnd, postHog, granted.svc).runCompOffExpiry();
    expect(granted.calls[0]).toBe(CronJobKey.LEAVE_COMP_OFF_EXPIRY);
    expect(compOff.expireCompOffLots).toHaveBeenCalledOnce();

    compOff.expireCompOffLots.mockClear();
    const held = lock(false);
    await new LeaveMaintenanceCron(compOff, yearEnd, postHog, held.svc).runCompOffExpiry();
    expect(compOff.expireCompOffLots).not.toHaveBeenCalled();
  });

  it('year-end wraps in single-flight with the right key', async () => {
    const compOff = { expireCompOffLots: vi.fn() } as any;
    const yearEnd = { runYearEndAllWorkspaces: vi.fn().mockResolvedValue({ errors: [] }) } as any;
    const l = lock(true);
    // Body has a Jan-only date guard, so we assert only the wrap + key here.
    await new LeaveMaintenanceCron(compOff, yearEnd, postHog, l.svc).runYearEnd();
    expect(l.calls[0]).toBe(CronJobKey.LEAVE_YEAR_END);
  });
});
