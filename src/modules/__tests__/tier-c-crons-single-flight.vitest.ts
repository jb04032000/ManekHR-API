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

import { SessionCleanupCron } from '../sessions/session-cleanup.cron';
import { InviteExpiryCron } from '../workspaces/invite-expiry.cron';
import { OffboardCron } from '../team/offboard.cron';
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

// Recycle-bin cron (Finance) was removed with the Finance product (2026-07-04).

function build(idx: number, lockSvc: any, probe: () => void): Promise<unknown> {
  switch (idx) {
    case 0:
      // session-cleanup: process() -> sessionsService.cleanupExpiredSessions() (probe).
      return new SessionCleanupCron(
        { cleanupExpiredSessions: () => Promise.resolve((probe(), 0)) } as any,
        lockSvc,
      ).handleCron();
    case 1:
      // invite-expiry: process() -> memberModel.find().limit().exec() (probe).
      return new InviteExpiryCron(
        { find: () => ({ limit: () => ({ exec: () => Promise.resolve((probe(), [])) }) }) } as any,
        {} as any,
        {} as any,
        lockSvc,
      ).run();
    case 2:
      // offboard: process() -> teamModel.find().select().exec() (probe).
      return new OffboardCron(
        { find: () => ({ select: () => ({ exec: () => Promise.resolve((probe(), [])) }) }) } as any,
        lockSvc,
      ).handleCron();
    default:
      throw new Error('bad idx');
  }
}

const expected = [
  CronJobKey.SESSION_CLEANUP,
  CronJobKey.INVITE_EXPIRY_SWEEP,
  CronJobKey.OFFBOARD_CRON,
];

describe('Tier C cleanup crons — single-flight gating', () => {
  beforeEach(() => vi.clearAllMocks());

  expected.forEach((key, idx) => {
    it(`${key} runs its body under the right key on claim`, async () => {
      const probe = vi.fn();
      const l = lock(true);
      await build(idx, l.svc, probe);
      expect(l.calls[0]).toBe(key);
      expect(probe).toHaveBeenCalled();
    });

    it(`${key} does no work when the claim is held`, async () => {
      const probe = vi.fn();
      const l = lock(false);
      await build(idx, l.svc, probe);
      expect(l.calls[0]).toBe(key);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
