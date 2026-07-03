/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migration 0040 (auth-hardening OQ-4): drop the stale 7-day expiresAt TTL
 * index on `sessions` and stamp retainUntil on already-cleared rows so the
 * login-audit trail enters the 1-year DPDP window instead of being deleted.
 * Links: migrate-session-audit-retention.ts, session.schema.ts.
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

import { MigrateSessionAuditRetentionService } from '../migrate-session-audit-retention';

function buildSessionModel(opts: { indexes: any[]; modifiedCount?: number }) {
  const collection = {
    indexes: vi.fn().mockResolvedValue(opts.indexes),
    dropIndex: vi.fn().mockResolvedValue(undefined),
  };
  return {
    collection,
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: opts.modifiedCount ?? 0 }),
  };
}

describe('MigrateSessionAuditRetentionService', () => {
  it('drops the stale expiresAt TTL index and stamps retainUntil on cleared rows', async () => {
    const model = buildSessionModel({
      indexes: [
        { name: '_id_', key: { _id: 1 } },
        { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
        { name: 'userId_1_isActive_1', key: { userId: 1, isActive: 1 } },
      ],
      modifiedCount: 5,
    });
    const svc = new MigrateSessionAuditRetentionService(model as any);

    const result = await svc.run();

    expect(model.collection.dropIndex).toHaveBeenCalledWith('expiresAt_1');
    expect(result.oldExpiresAtTtlIndexDropped).toBe(true);
    expect(result.rowsStampedRetainUntil).toBe(5);
    // The retainUntil stamp targets cleared rows missing the field.
    const filter = model.updateMany.mock.calls[0][0];
    expect(filter.retainUntil).toEqual({ $in: [null, undefined] });
    expect(filter.$or).toBeDefined();
    const setArg = model.updateMany.mock.calls[0][1].$set;
    expect(setArg.retainUntil).toBeInstanceOf(Date);
    // AUTH-H2: the backfill must mirror the cron's update shape — clear the dead
    // Bucket-C jwtTokenHash to '' (else the cron, which only revisits rows with a
    // null retainUntil, never clears it and it lingers for the full year) and
    // flip isActive:false.
    expect(setArg.jwtTokenHash).toBe('');
    expect(setArg.isActive).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('is idempotent: no stale TTL index and no unstamped rows -> no-op', async () => {
    const model = buildSessionModel({
      indexes: [
        { name: '_id_', key: { _id: 1 } },
        // Already on the new retainUntil TTL index; no expiresAt TTL.
        { name: 'retainUntil_1', key: { retainUntil: 1 }, expireAfterSeconds: 0 },
      ],
      modifiedCount: 0,
    });
    const svc = new MigrateSessionAuditRetentionService(model as any);

    const result = await svc.run();

    expect(model.collection.dropIndex).not.toHaveBeenCalled();
    expect(result.oldExpiresAtTtlIndexDropped).toBe(false);
    expect(result.rowsStampedRetainUntil).toBe(0);
  });

  it('leaves a non-TTL expiresAt index untouched (only TTL form is dropped)', async () => {
    const model = buildSessionModel({
      // A plain (non-TTL) expiresAt index has no expireAfterSeconds.
      indexes: [{ name: 'expiresAt_1', key: { expiresAt: 1 } }],
      modifiedCount: 0,
    });
    const svc = new MigrateSessionAuditRetentionService(model as any);

    const result = await svc.run();

    expect(model.collection.dropIndex).not.toHaveBeenCalled();
    expect(result.oldExpiresAtTtlIndexDropped).toBe(false);
  });
});
