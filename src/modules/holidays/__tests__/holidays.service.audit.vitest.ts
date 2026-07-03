/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service - the
// transitive schema imports would otherwise trip vitest's esbuild reflection
// pipeline. Mirrors the leave W4 audit-spec pattern (`leave.audit.vitest.ts`).
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { HolidaysService } from '../holidays.service';
import { AppModule as AppModuleEnum } from '../../../common/enums/modules.enum';

/**
 * Audit + PostHog fire-and-forget coverage for the H2 holiday write paths.
 *
 * Verifies, for create / update / remove:
 *   - the right `holiday.*` audit action fires via `auditService.logEvent`
 *     with `module: AppModule.HOLIDAYS`, `entityType: 'holiday'`, and the
 *     ACTOR user id (Playbook P8);
 *   - the matching PostHog event fires with the acting user as distinct-id;
 *   - a Mongo E11000 on create maps to a friendly ConflictException;
 *   - audit failures are swallowed and never break the caller.
 *
 * Mirrors `leave/__tests__/leave.audit.vitest.ts` (incl. the `@nestjs/mongoose`
 * decorator-mock). PostHog + Sentry are mocked.
 */
describe('Holidays module - audit + PostHog (H2)', () => {
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };

  const workspaceId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const holidayObjId = new Types.ObjectId();

  /** Find the audit call for a given action string. */
  function auditCall(action: string): any[] | undefined {
    return auditService.logEvent.mock.calls.find((c: any[]) => c[0].action === action);
  }

  /** Find the posthog capture call for a given event string. */
  function postHogCall(event: string): any[] | undefined {
    return postHog.capture.mock.calls.find((c: any[]) => c[0].event === event);
  }

  beforeEach(() => {
    auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
    postHog = { capture: vi.fn(), identify: vi.fn() };
  });

  // ── create ───────────────────────────────────────────────────────────

  it('fires holiday.created audit + posthog on create success', async () => {
    const savedDoc = {
      _id: holidayObjId,
      name: 'Diwali',
      type: 'festival',
      isRecurring: true,
      save: vi.fn(),
    };
    savedDoc.save.mockResolvedValue(savedDoc);

    // `new this.holidayModel(...)` must return our doc; findOne pre-check returns null.
    const ModelCtor: any = vi.fn().mockImplementation(() => savedDoc);
    ModelCtor.findOne = vi.fn().mockResolvedValue(null);

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await svc.create(workspaceId, userId, {
      name: 'Diwali',
      date: '2026-11-08',
      isRecurring: true,
      type: 'festival',
    } as any);

    const aCall = auditCall('holiday.created');
    expect(aCall).toBeDefined();
    expect(aCall[0]).toMatchObject({
      module: AppModuleEnum.HOLIDAYS,
      entityType: 'holiday',
      action: 'holiday.created',
      entityId: holidayObjId.toString(),
      actorId: userId,
      workspaceId,
    });

    const pCall = postHogCall('holiday.created');
    expect(pCall).toBeDefined();
    expect(pCall[0]).toMatchObject({
      distinctId: userId,
      event: 'holiday.created',
      properties: { workspaceId, holidayId: holidayObjId.toString(), type: 'festival' },
    });
  });

  it('maps Mongo E11000 on create to a friendly ConflictException', async () => {
    const e11000: Error & { code: number } = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
    });
    const doc: any = {
      _id: holidayObjId,
      save: vi.fn().mockRejectedValue(e11000),
    };
    const ModelCtor: any = vi.fn().mockImplementation(() => doc);
    ModelCtor.findOne = vi.fn().mockResolvedValue(null);

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(
      svc.create(workspaceId, userId, { name: 'X', date: '2026-01-26' } as any),
    ).rejects.toThrow(ConflictException);
    await expect(
      svc.create(workspaceId, userId, { name: 'X', date: '2026-01-26' } as any),
    ).rejects.toThrow('A holiday already exists on this date');
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-recurring duplicate via the pre-check ConflictException', async () => {
    const ModelCtor: any = vi.fn();
    ModelCtor.findOne = vi.fn().mockResolvedValue({ _id: holidayObjId });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(
      svc.create(workspaceId, userId, { name: 'X', date: '2026-01-26' } as any),
    ).rejects.toThrow(ConflictException);
  });

  // ── update ───────────────────────────────────────────────────────────

  it('fires holiday.updated audit + posthog on update success', async () => {
    const updatedDoc = {
      _id: holidayObjId,
      toObject: () => ({ _id: holidayObjId, name: 'Updated' }),
    };
    const ModelCtor: any = vi.fn();
    ModelCtor.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(updatedDoc),
    });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await svc.update(workspaceId, holidayObjId.toString(), userId, {
      name: 'Updated',
      date: '2026-11-09',
    });

    const aCall = auditCall('holiday.updated');
    expect(aCall).toBeDefined();
    expect(aCall[0]).toMatchObject({
      module: AppModuleEnum.HOLIDAYS,
      entityType: 'holiday',
      action: 'holiday.updated',
      entityId: holidayObjId.toString(),
      actorId: userId,
    });
    expect(aCall[0].meta.fields).toContain('name');

    const pCall = postHogCall('holiday.updated');
    expect(pCall).toBeDefined();
    expect(pCall[0].distinctId).toBe(userId);
  });

  it('throws NotFoundException when update target is missing', async () => {
    const ModelCtor: any = vi.fn();
    ModelCtor.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(
      svc.update(workspaceId, holidayObjId.toString(), userId, { name: 'X' } as any),
    ).rejects.toThrow(NotFoundException);
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  // ── remove ───────────────────────────────────────────────────────────

  it('fires holiday.deleted audit + posthog on remove success', async () => {
    const deletedDoc = { _id: holidayObjId, name: 'Diwali', type: 'festival' };
    const ModelCtor: any = vi.fn();
    ModelCtor.findOneAndDelete = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(deletedDoc),
    });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await svc.remove(workspaceId, holidayObjId.toString(), userId);

    const aCall = auditCall('holiday.deleted');
    expect(aCall).toBeDefined();
    expect(aCall[0]).toMatchObject({
      module: AppModuleEnum.HOLIDAYS,
      entityType: 'holiday',
      action: 'holiday.deleted',
      entityId: holidayObjId.toString(),
      actorId: userId,
    });

    const pCall = postHogCall('holiday.deleted');
    expect(pCall).toBeDefined();
    expect(pCall[0].distinctId).toBe(userId);
  });

  it('throws NotFoundException when remove target is missing', async () => {
    const ModelCtor: any = vi.fn();
    ModelCtor.findOneAndDelete = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(svc.remove(workspaceId, holidayObjId.toString(), userId)).rejects.toThrow(
      NotFoundException,
    );
    expect(auditService.logEvent).not.toHaveBeenCalled();
  });

  // ── audit failure is swallowed ─────────────────────────────────────────

  it('swallows an audit failure and does NOT break create', async () => {
    auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));
    const savedDoc = {
      _id: holidayObjId,
      name: 'Holi',
      type: 'festival',
      isRecurring: false,
      save: vi.fn(),
    };
    savedDoc.save.mockResolvedValue(savedDoc);
    const ModelCtor: any = vi.fn().mockImplementation(() => savedDoc);
    ModelCtor.findOne = vi.fn().mockResolvedValue(null);

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(
      svc.create(workspaceId, userId, { name: 'Holi', date: '2026-03-14' } as any),
    ).resolves.toBeDefined();
    expect(auditService.logEvent).toHaveBeenCalled();
  });

  // ── (A) bulkCreate ─────────────────────────────────────────────────────

  it('bulkCreate returns all inserted rows when none collide', async () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    const ModelCtor: any = vi.fn();
    // ordered:false insertMany resolves with the inserted docs on full success.
    ModelCtor.insertMany = vi.fn().mockResolvedValue([{ _id: ids[0] }, { _id: ids[1] }]);

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    const res = await svc.bulkCreate(workspaceId, userId, [
      { name: 'A', date: '2026-01-01' } as any,
      { name: 'B', date: '2026-01-26' } as any,
    ]);

    expect(res.created).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    expect(ModelCtor.insertMany).toHaveBeenCalledWith(expect.any(Array), { ordered: false });
    // ONE batch audit event (not N).
    const aCall = auditCall('holiday.bulk_created');
    expect(aCall).toBeDefined();
    expect(aCall[0].meta).toMatchObject({ requested: 2, created: 2, skipped: 0 });
  });

  it('bulkCreate maps E11000 write-errors to per-date skips and keeps inserted rows', async () => {
    const insertedId = new Types.ObjectId();
    // MongoBulkWriteError shape: insertedDocs = rows that landed; writeErrors carry
    // the failing index + dup-key code so each can be mapped back to its date.
    const bulkErr: any = Object.assign(new Error('E11000 duplicate key'), {
      name: 'MongoBulkWriteError',
      insertedDocs: [{ _id: insertedId }],
      writeErrors: [{ code: 11000, index: 1 }],
    });
    const ModelCtor: any = vi.fn();
    ModelCtor.insertMany = vi.fn().mockRejectedValue(bulkErr);

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    const res = await svc.bulkCreate(workspaceId, userId, [
      { name: 'A', date: '2026-01-01' } as any,
      { name: 'B', date: '2026-01-26' } as any, // index 1 → collides
    ]);

    expect(res.created).toHaveLength(1);
    expect(res.skipped).toEqual([{ date: '2026-01-26', reason: 'already_exists' }]);
  });

  it('bulkCreate rethrows a non-duplicate insert error', async () => {
    const fatal = Object.assign(new Error('connection reset'), { code: 99 });
    const ModelCtor: any = vi.fn();
    ModelCtor.insertMany = vi.fn().mockRejectedValue(fatal);

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(
      svc.bulkCreate(workspaceId, userId, [{ name: 'A', date: '2026-01-01' } as any]),
    ).rejects.toThrow('connection reset');
  });

  // ── (B) isHolidayOn resolver ───────────────────────────────────────────

  it('isHolidayOn returns true when an exact-date or recurring holiday matches', async () => {
    const ModelCtor: any = vi.fn();
    ModelCtor.exists = vi.fn().mockReturnValue({
      exec: () => Promise.resolve({ _id: holidayObjId }),
    });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(svc.isHolidayOn(workspaceId, new Date('2026-01-26T00:00:00Z'))).resolves.toBe(
      true,
    );
  });

  it('isHolidayOn returns false when no holiday matches the date', async () => {
    const ModelCtor: any = vi.fn();
    ModelCtor.exists = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    const svc = new HolidaysService(ModelCtor, auditService as any, postHog as any);
    await expect(svc.isHolidayOn(workspaceId, new Date('2026-02-15T00:00:00Z'))).resolves.toBe(
      false,
    );
  });
});
