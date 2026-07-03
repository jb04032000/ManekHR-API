/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv/config', () => ({}));
vi.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_HOUR: '0 * * * *' },
}));
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

import { DefaulterAlertCron } from '../attendance/crons/defaulter-alert.cron';
import { MaintenanceNotificationsCron } from '../maintenance/maintenance-notifications.cron';
import { Msg91BalanceService } from '../sms/services/msg91-balance.service';
import { UnassignedDigestCron } from '../attendance-devices/crons/unassigned-digest.cron';
import { AddOnsService } from '../add-ons/add-ons.service';
import { CronJobKey } from '../../common/constants/cron.constants';

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
// Chainable mongoose query stub that resolves to [] and records that the body ran.
function chain(probe: () => void): any {
  const c: any = {};
  for (const m of ['find', 'select', 'lean', 'populate', 'sort']) c[m] = () => c;
  c.exec = () => Promise.resolve((probe(), []));
  c.then = (resolve: any) => resolve((probe(), []));
  return c;
}
const findModel = (probe: () => void) => ({
  find: () => chain(probe),
  distinct: () => ({ exec: () => Promise.resolve((probe(), [])) }),
});

describe('Tier A final crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DefaulterAlertCron wraps with DEFAULTER_ALERT key + gates body', async () => {
    const probe = vi.fn();
    const granted = lock(true);
    await new DefaulterAlertCron(
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      granted.svc,
    ).run();
    expect(granted.calls[0]).toBe(CronJobKey.DEFAULTER_ALERT);
    expect(probe).toHaveBeenCalled();

    const held = lock(false);
    probe.mockClear();
    await new DefaulterAlertCron(
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      held.svc,
    ).run();
    expect(probe).not.toHaveBeenCalled();
  });

  it('MaintenanceNotificationsCron wraps with MAINTENANCE_NOTIFICATIONS key + gates body', async () => {
    const probe = vi.fn();
    const granted = lock(true);
    await new MaintenanceNotificationsCron(
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      granted.svc,
    ).run();
    expect(granted.calls[0]).toBe(CronJobKey.MAINTENANCE_NOTIFICATIONS);
    expect(probe).toHaveBeenCalled();

    const held = lock(false);
    probe.mockClear();
    await new MaintenanceNotificationsCron(
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      held.svc,
    ).run();
    expect(probe).not.toHaveBeenCalled();
  });

  it('UnassignedDigestCron wraps with ATTENDANCE_UNASSIGNED_DIGEST key + gates body', async () => {
    const probe = vi.fn();
    const granted = lock(true);
    await new UnassignedDigestCron(
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      granted.svc,
    ).sendDailyDigests();
    expect(granted.calls[0]).toBe(CronJobKey.ATTENDANCE_UNASSIGNED_DIGEST);
    expect(probe).toHaveBeenCalled();

    const held = lock(false);
    probe.mockClear();
    await new UnassignedDigestCron(
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      held.svc,
    ).sendDailyDigests();
    expect(probe).not.toHaveBeenCalled();
  });

  it('AddOnsService.processExpiredAddOns wraps with EXPIRED_ADDONS key', async () => {
    const probe = vi.fn();
    const l = lock(true);
    const svc = new AddOnsService(
      {} as any,
      findModel(probe) as any,
      findModel(() => undefined) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      l.svc,
    );
    await svc.processExpiredAddOns();
    expect(l.calls[0]).toBe(CronJobKey.EXPIRED_ADDONS);
    expect(probe).toHaveBeenCalled();
  });

  it('AddOnsService.processCommunicationsCreditChecks wraps with ADDONS_CREDIT_CHECKS key', async () => {
    const probe = vi.fn();
    const l = lock(true);
    const svc = new AddOnsService(
      {} as any,
      {} as any,
      findModel(probe) as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      l.svc,
    );
    await svc.processCommunicationsCreditChecks();
    expect(l.calls[0]).toBe(CronJobKey.ADDONS_CREDIT_CHECKS);
    expect(probe).toHaveBeenCalled();
  });

  // msg91 body is env-gated (isEnabled reads env.msg91.authKey, empty in tests),
  // so we assert the wrap + key for both claim outcomes; body gating is proven by
  // the SingleFlightService unit test.
  it('Msg91BalanceService.runHourlyPoll wraps with MSG91_BALANCE_POLL key', async () => {
    // config.get returns undefined -> isEnabled() is false -> the body cleanly
    // short-circuits. We assert only the wrap + key (body gating is proven by the
    // SingleFlightService unit test).
    const config = { get: vi.fn().mockReturnValue(undefined) } as any;
    const granted = lock(true);
    await new Msg91BalanceService(config, {} as any, {} as any, granted.svc).runHourlyPoll();
    expect(granted.calls[0]).toBe(CronJobKey.MSG91_BALANCE_POLL);

    const held = lock(false);
    await new Msg91BalanceService(config, {} as any, {} as any, held.svc).runHourlyPoll();
    expect(held.calls[0]).toBe(CronJobKey.MSG91_BALANCE_POLL);
  });
});
