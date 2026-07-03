/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// SubscriptionsService's import graph reaches src/config/env.ts, whose
// `import 'dotenv/config'` side-effect import is unresolvable under vitest.
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

import { SubscriptionsService } from '../subscriptions.service';
import { IncludedCreditsGrantCron } from '../../connect/monetization/crons/included-credits-grant.cron';
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

describe('subscription + monetization crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeSubsService(lockSvc: any, probe: () => void) {
    const subscriptionModel = {
      // populate() must expose BOTH `.lean()` (processScheduledSubscriptions)
      // and `.exec()` (runExpireStaleSubscriptions trial-downgrade query).
      find: vi.fn(() => ({
        populate: () => ({
          lean: () => Promise.resolve((probe(), [])),
          exec: () => Promise.resolve((probe(), [])),
        }),
      })),
      updateMany: vi.fn(() => Promise.resolve((probe(), { modifiedCount: 0 }))),
    } as any;
    const svc = new SubscriptionsService(
      {} as any, // planModel
      subscriptionModel,
      {} as any, // appSettingsModel
      {} as any, // tierModel
      {} as any, // workspaceModel
      {} as any, // workspaceMemberModel
      {} as any, // addOnsService
      lockSvc,
    );
    return svc;
  }

  it('processScheduledSubscriptions wraps with SCHEDULED_SUBSCRIPTIONS key', async () => {
    const probe = vi.fn();
    const l = lock(true);
    await makeSubsService(l.svc, probe).processScheduledSubscriptions();
    expect(l.calls[0]).toBe(CronJobKey.SCHEDULED_SUBSCRIPTIONS);
    expect(probe).toHaveBeenCalled();
  });

  it('processScheduledSubscriptions does nothing when claim held', async () => {
    const probe = vi.fn();
    const l = lock(false);
    await makeSubsService(l.svc, probe).processScheduledSubscriptions();
    expect(probe).not.toHaveBeenCalled();
  });

  it('expireStaleSubscriptions wraps with EXPIRE_STALE key', async () => {
    const probe = vi.fn();
    const l = lock(true);
    await makeSubsService(l.svc, probe).expireStaleSubscriptions();
    expect(l.calls[0]).toBe(CronJobKey.SUBSCRIPTION_EXPIRE_STALE);
    expect(probe).toHaveBeenCalled();
  });

  it('expireStaleSubscriptions does nothing when claim held', async () => {
    const probe = vi.fn();
    const l = lock(false);
    await makeSubsService(l.svc, probe).expireStaleSubscriptions();
    expect(probe).not.toHaveBeenCalled();
  });

  it('IncludedCreditsGrantCron wraps with CONNECT_INCLUDED_CREDITS key', async () => {
    const probe = vi.fn();
    const subscriptionModel = {
      find: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve((probe(), [])) }) })),
    } as any;
    const l = lock(true);
    await new IncludedCreditsGrantCron(subscriptionModel, {} as any, l.svc).run();
    expect(l.calls[0]).toBe(CronJobKey.CONNECT_INCLUDED_CREDITS);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('IncludedCreditsGrantCron does nothing when claim held', async () => {
    const probe = vi.fn();
    const subscriptionModel = {
      find: vi.fn(() => ({ lean: () => ({ exec: () => Promise.resolve((probe(), [])) }) })),
    } as any;
    const l = lock(false);
    await new IncludedCreditsGrantCron(subscriptionModel, {} as any, l.svc).run();
    expect(probe).not.toHaveBeenCalled();
  });
});
