/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the service - the
// transitive schema imports would otherwise trip vitest's esbuild reflection
// pipeline. Mirrors the holidays H2 audit-spec pattern
// (`holidays.service.audit.vitest.ts`).
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

import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ShiftsService } from '../shifts.service';
import { AppModule as AppModuleEnum } from '../../../common/enums/modules.enum';

/**
 * Audit + PostHog fire-and-forget coverage for the S2 shift write paths.
 *
 * Verifies, for create / update / remove:
 *   - the right `shift.*` audit action fires via `auditService.logEvent`
 *     with `module: AppModule.SHIFTS`, `entityType: 'shift'`, and the
 *     ACTOR user id (Playbook P8);
 *   - the matching PostHog event fires with the acting user as distinct-id;
 *   - NotFound paths short-circuit before audit / posthog;
 *   - audit failures are swallowed and never break the caller.
 *
 * Mirrors `holidays/__tests__/holidays.service.audit.vitest.ts` (incl. the
 * `@nestjs/mongoose` decorator-mock). PostHog + Sentry are mocked.
 */
describe('Shifts module - audit + PostHog (S2)', () => {
  let auditService: { logEvent: ReturnType<typeof vi.fn> };
  let postHog: { capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> };

  const workspaceId = new Types.ObjectId().toHexString();
  const userId = new Types.ObjectId().toHexString();
  const shiftObjId = new Types.ObjectId();

  // Always-defined TeamMember model stub - the service constructor wires it
  // in, but the write paths never touch it (only `findAll` does, and the
  // tests below don't exercise findAll). Keeping it harmless.
  const teamModel: any = vi.fn();

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

  // create ----------------------------------------------------------------

  it('fires shift.created audit + posthog on create success', async () => {
    const savedDoc = {
      _id: shiftObjId,
      name: 'Morning',
      shiftType: 'fixed',
      isDefault: true,
      save: vi.fn(),
    };
    savedDoc.save.mockResolvedValue(savedDoc);

    // `new this.shiftModel(...)` must return our doc.
    const ShiftModelCtor: any = vi.fn().mockImplementation(() => savedDoc);

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await svc.create(workspaceId, userId, {
      name: 'Morning',
      startTime: '06:00',
      endTime: '14:00',
      isDefault: true,
      shiftType: 'fixed',
    } as any);

    const aCall = auditCall('shift.created');
    expect(aCall).toBeDefined();
    expect(aCall[0]).toMatchObject({
      module: AppModuleEnum.SHIFTS,
      entityType: 'shift',
      action: 'shift.created',
      entityId: shiftObjId.toString(),
      actorId: userId,
      workspaceId,
    });
    expect(aCall[0].meta).toMatchObject({
      name: 'Morning',
      shiftType: 'fixed',
      isDefault: true,
    });

    const pCall = postHogCall('shift.created');
    expect(pCall).toBeDefined();
    expect(pCall[0]).toMatchObject({
      distinctId: userId,
      event: 'shift.created',
      properties: {
        workspaceId,
        shiftId: shiftObjId.toString(),
        name: 'Morning',
        shiftType: 'fixed',
        isDefault: true,
      },
    });
  });

  // update ----------------------------------------------------------------

  it('fires shift.updated audit + posthog on update success', async () => {
    const updatedDoc = {
      _id: shiftObjId,
      name: 'Morning v2',
      shiftType: 'fixed',
    };
    const ShiftModelCtor: any = vi.fn();
    ShiftModelCtor.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(updatedDoc),
    });

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await svc.update(workspaceId, shiftObjId.toString(), userId, {
      name: 'Morning v2',
      startTime: '06:30',
    } as any);

    const aCall = auditCall('shift.updated');
    expect(aCall).toBeDefined();
    expect(aCall[0]).toMatchObject({
      module: AppModuleEnum.SHIFTS,
      entityType: 'shift',
      action: 'shift.updated',
      entityId: shiftObjId.toString(),
      actorId: userId,
      workspaceId,
    });
    expect(aCall[0].meta.fields).toContain('name');
    expect(aCall[0].meta.fields).toContain('startTime');

    const pCall = postHogCall('shift.updated');
    expect(pCall).toBeDefined();
    expect(pCall[0].distinctId).toBe(userId);
    expect(pCall[0].properties.fields).toContain('name');
  });

  it('throws NotFoundException when update target is missing', async () => {
    const ShiftModelCtor: any = vi.fn();
    ShiftModelCtor.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await expect(
      svc.update(workspaceId, shiftObjId.toString(), userId, { name: 'X' } as any),
    ).rejects.toThrow(NotFoundException);
    expect(auditService.logEvent).not.toHaveBeenCalled();
    expect(postHog.capture).not.toHaveBeenCalled();
  });

  // remove ----------------------------------------------------------------

  it('fires shift.deleted audit + posthog on remove success', async () => {
    const deletedDoc = { _id: shiftObjId, name: 'Night', shiftType: 'fixed' };
    const ShiftModelCtor: any = vi.fn();
    ShiftModelCtor.findOneAndDelete = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(deletedDoc),
    });

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await svc.remove(workspaceId, shiftObjId.toString(), userId);

    const aCall = auditCall('shift.deleted');
    expect(aCall).toBeDefined();
    expect(aCall[0]).toMatchObject({
      module: AppModuleEnum.SHIFTS,
      entityType: 'shift',
      action: 'shift.deleted',
      entityId: shiftObjId.toString(),
      actorId: userId,
      workspaceId,
    });
    expect(aCall[0].meta).toMatchObject({ name: 'Night', shiftType: 'fixed' });

    const pCall = postHogCall('shift.deleted');
    expect(pCall).toBeDefined();
    expect(pCall[0].distinctId).toBe(userId);
    expect(pCall[0].properties).toMatchObject({
      workspaceId,
      shiftId: shiftObjId.toString(),
      name: 'Night',
      shiftType: 'fixed',
    });
  });

  it('throws NotFoundException when remove target is missing', async () => {
    const ShiftModelCtor: any = vi.fn();
    ShiftModelCtor.findOneAndDelete = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(null),
    });

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await expect(svc.remove(workspaceId, shiftObjId.toString(), userId)).rejects.toThrow(
      NotFoundException,
    );
    expect(auditService.logEvent).not.toHaveBeenCalled();
    expect(postHog.capture).not.toHaveBeenCalled();
  });

  // audit failure is swallowed -------------------------------------------

  it('swallows an audit failure and does NOT break create', async () => {
    auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));
    const savedDoc = {
      _id: shiftObjId,
      name: 'Day',
      shiftType: 'fixed',
      isDefault: false,
      save: vi.fn(),
    };
    savedDoc.save.mockResolvedValue(savedDoc);
    const ShiftModelCtor: any = vi.fn().mockImplementation(() => savedDoc);

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await expect(
      svc.create(workspaceId, userId, {
        name: 'Day',
        startTime: '09:00',
        endTime: '17:00',
      } as any),
    ).resolves.toBeDefined();
    expect(auditService.logEvent).toHaveBeenCalled();
    // The PostHog event still fires - audit + posthog are independent.
    expect(postHog.capture).toHaveBeenCalled();
  });

  it('swallows an audit failure and does NOT break update', async () => {
    auditService.logEvent.mockRejectedValueOnce(new Error('audit DB down'));
    const updatedDoc = { _id: shiftObjId, name: 'Day' };
    const ShiftModelCtor: any = vi.fn();
    ShiftModelCtor.findOneAndUpdate = vi.fn().mockReturnValue({
      exec: () => Promise.resolve(updatedDoc),
    });

    const svc = new ShiftsService(ShiftModelCtor, teamModel, auditService as any, postHog as any);
    await expect(
      svc.update(workspaceId, shiftObjId.toString(), userId, { name: 'Day' } as any),
    ).resolves.toBeDefined();
    expect(auditService.logEvent).toHaveBeenCalled();
  });
});
