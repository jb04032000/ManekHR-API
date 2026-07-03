/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv/config', () => ({}));
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

import { MaintenanceCountersCron } from '../maintenance-counters.cron';
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

// process() loads workspaces via find().select().lean().exec() before any work.
const workspaceModel = (probe: () => void) =>
  ({
    find: () => ({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve((probe(), [])) }) }),
    }),
  }) as any;

describe('maintenance counters cron — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('MAINTENANCE_COUNTER_REFRESH runs its body under the right key on claim', async () => {
    const probe = vi.fn();
    const l = lock(true);
    await new MaintenanceCountersCron(workspaceModel(probe), {} as any, l.svc).run();
    expect(l.calls[0]).toBe(CronJobKey.MAINTENANCE_COUNTER_REFRESH);
    expect(probe).toHaveBeenCalled();
  });

  it('MAINTENANCE_COUNTER_REFRESH does no work when the claim is held', async () => {
    const probe = vi.fn();
    const l = lock(false);
    await new MaintenanceCountersCron(workspaceModel(probe), {} as any, l.svc).run();
    expect(l.calls[0]).toBe(CronJobKey.MAINTENANCE_COUNTER_REFRESH);
    expect(probe).not.toHaveBeenCalled();
  });
});
