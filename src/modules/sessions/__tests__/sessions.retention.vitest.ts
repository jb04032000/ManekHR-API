/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OQ-4 session audit-retention: applySessionRetention clears the dead
 * jwtTokenHash (Bucket C) and stamps retainUntil = now + 1 year (Bucket D) on
 * cleared rows, idempotently (rows already carrying retainUntil are skipped).
 * Links: sessions.service.ts (applySessionRetention), session-cleanup.cron.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { SessionsService } from '../sessions.service';

describe('SessionsService.applySessionRetention (OQ-4)', () => {
  function build(modifiedCount: number) {
    const sessionModel = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount }),
    };
    const svc = new SessionsService(
      sessionModel as any,
      { findOne: vi.fn() } as any, // tokenDenylistModel — unused here
      { getUserSubscription: vi.fn() } as any, // subscriptionsService
      { findById: vi.fn() } as any, // usersService
    );
    return { svc, sessionModel };
  }

  it('clears jwtTokenHash and stamps a 1-year retainUntil on cleared rows', async () => {
    const { svc, sessionModel } = build(7);

    const count = await svc.applySessionRetention();

    expect(count).toBe(7);
    const [filter, update] = sessionModel.updateMany.mock.calls[0];
    // Targets cleared rows (inactive OR past expiry) that are not yet stamped.
    expect(filter.$or).toEqual([{ isActive: false }, { expiresAt: { $lt: expect.any(Date) } }]);
    expect(filter.retainUntil).toEqual({ $in: [null, undefined] });
    // Bucket C cleared, Bucket D window opened ~1 year out.
    expect(update.$set.jwtTokenHash).toBe('');
    expect(update.$set.isActive).toBe(false);
    const retainUntil: Date = update.$set.retainUntil;
    const daysOut = (retainUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(360);
    expect(daysOut).toBeLessThan(370);
  });

  it('is idempotent: only unstamped rows are matched (re-run is a no-op)', async () => {
    const { svc, sessionModel } = build(0);
    const count = await svc.applySessionRetention();
    expect(count).toBe(0);
    expect(sessionModel.updateMany.mock.calls[0][0].retainUntil).toEqual({
      $in: [null, undefined],
    });
  });
});
