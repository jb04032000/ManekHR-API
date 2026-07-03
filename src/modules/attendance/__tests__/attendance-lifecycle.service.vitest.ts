/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { AttendanceLifecycleService } from '../attendance-lifecycle.service';

/**
 * Attendance hardening Pillar 1 — AttendanceLifecycleService covers:
 *   - memberHasHistory() Remove-vs-Delete gate (AC-1.1 / OQ-A1): true when any
 *     Attendance projection row OR any AttendanceEvent exists.
 *   - onMemberRemoved() cascade (OQ-A6 → B): IMMEDIATELY scrub the kiosk
 *     credential, NEVER delete a Bucket-B row.
 */
function existsModel(hit: boolean) {
  return { exists: vi.fn().mockResolvedValue(hit ? { _id: 'x' } : null) };
}
function updateOneMock(modifiedCount: number) {
  return vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({ modifiedCount }) });
}

function makeService(overrides: { attendance?: any; event?: any; teamModified?: number } = {}) {
  const attendanceModel = overrides.attendance ?? existsModel(false);
  const eventModel = overrides.event ?? existsModel(false);
  const teamModel = { updateOne: updateOneMock(overrides.teamModified ?? 1) };
  const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };

  const service = new AttendanceLifecycleService(
    attendanceModel,
    eventModel,
    teamModel as any,
    audit as any,
  );
  return { service, attendanceModel, eventModel, teamModel, audit };
}

const WS = '5f8d04b3b54764421b7156aa';
const TM = '5f8d04b3b54764421b7156bb';

describe('AttendanceLifecycleService.memberHasHistory (AC-1.1 / OQ-A1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when there is no Attendance row and no AttendanceEvent', async () => {
    const { service } = makeService();
    await expect(service.memberHasHistory(WS, TM)).resolves.toBe(false);
  });

  it('returns true when an Attendance projection row exists', async () => {
    const { service } = makeService({ attendance: existsModel(true) });
    await expect(service.memberHasHistory(WS, TM)).resolves.toBe(true);
  });

  it('returns true when only a raw AttendanceEvent exists (no projection row)', async () => {
    const { service } = makeService({ attendance: existsModel(false), event: existsModel(true) });
    await expect(service.memberHasHistory(WS, TM)).resolves.toBe(true);
  });

  it('short-circuits the event probe when the attendance probe already hit', async () => {
    const { service, eventModel } = makeService({ attendance: existsModel(true) });
    await service.memberHasHistory(WS, TM);
    expect(eventModel.exists).not.toHaveBeenCalled();
  });
});

describe('AttendanceLifecycleService.onMemberRemoved (OQ-A6 → B)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the kiosk credential immediately and reports it', async () => {
    const { service, teamModel, audit } = makeService({ teamModified: 1 });
    const result = await service.onMemberRemoved(WS, TM, 'actor1');
    expect(result).toEqual({ kioskCredentialCleared: true });
    // The scrub sets all three kiosk fields.
    expect(teamModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything() }),
      { $set: { kioskPinHash: null, kioskLockedUntil: null, kioskFailedAttempts: 0 } },
    );
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
  });

  it('reports kioskCredentialCleared=false when nothing was set', async () => {
    const { service } = makeService({ teamModified: 0 });
    const result = await service.onMemberRemoved(WS, TM, 'actor1');
    expect(result.kioskCredentialCleared).toBe(false);
  });

  it('never deletes any Attendance or AttendanceEvent row', async () => {
    const attendance = Object.assign(existsModel(false), {
      deleteMany: vi.fn(),
      deleteOne: vi.fn(),
    });
    const event = Object.assign(existsModel(false), { deleteMany: vi.fn(), deleteOne: vi.fn() });
    const { service } = makeService({ attendance, event });
    await service.onMemberRemoved(WS, TM, 'actor1');
    expect(attendance.deleteMany).not.toHaveBeenCalled();
    expect(attendance.deleteOne).not.toHaveBeenCalled();
    expect(event.deleteMany).not.toHaveBeenCalled();
    expect(event.deleteOne).not.toHaveBeenCalled();
  });

  it('does not throw when the audit write fails (non-fatal)', async () => {
    const { service, audit } = makeService();
    audit.logEvent.mockRejectedValueOnce(new Error('audit down'));
    await expect(service.onMemberRemoved(WS, TM, 'actor1')).resolves.toEqual({
      kioskCredentialCleared: true,
    });
  });
});
