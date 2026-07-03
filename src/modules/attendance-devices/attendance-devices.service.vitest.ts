import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AttendanceDevicesService } from './attendance-devices.service';

// ---------------------------------------------------------------------------
// Minimal mock factory for a Mongoose document with status + save()
// ---------------------------------------------------------------------------
function makeDevice(status: string) {
  const doc: any = {
    status,
    alias: null,
    firmwareVersion: null,
    save: vi.fn().mockImplementation(function (this: any) {
      return Promise.resolve(this);
    }),
  };
  return doc;
}

function buildService(overrides: Partial<{
  deviceModel: any;
  eventModel: any;
  teamMemberModel: any;
  workspaceModel: any;
  ingestService: any;
  projectionService: any;
}> = {}): AttendanceDevicesService {
  const deviceModel = overrides.deviceModel ?? {
    find: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ sort: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }) }) }),
    findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    create: vi.fn().mockResolvedValue({}),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const eventModel = overrides.eventModel ?? {
    aggregate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
  const teamMemberModel = overrides.teamMemberModel ?? {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const workspaceModel = overrides.workspaceModel ?? {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    }),
  };
  const ingestService = overrides.ingestService ?? {
    evictFromCache: vi.fn(),
  };
  const projectionService = overrides.projectionService ?? {
    recompute: vi.fn().mockResolvedValue({ updated: true }),
  };

  // @ts-expect-error — test instantiation bypasses DI
  return new AttendanceDevicesService(
    deviceModel,
    eventModel,
    teamMemberModel,
    workspaceModel,
    ingestService,
    projectionService,
  );
}

// Valid 24-char hex ObjectId strings for tests
const WS_ID = '507f191e810c19729de860ea';
const DEV_ID = '507f1f77bcf86cd799439011';

// ---------------------------------------------------------------------------
// Status transition tests
// ---------------------------------------------------------------------------

describe('AttendanceDevicesService status transitions', () => {
  it('approve: transitions pending_approval → active', async () => {
    const device = makeDevice('pending_approval');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    const result = await svc.approveDevice(WS_ID, DEV_ID);
    expect(device.status).toBe('active');
    expect(device.save).toHaveBeenCalled();
    expect(result.status).toBe('active');
  });

  it('approve: throws if device is not pending_approval', async () => {
    const device = makeDevice('active');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    await expect(svc.approveDevice(WS_ID, DEV_ID)).rejects.toThrow(BadRequestException);
  });

  it('pause: transitions active → paused', async () => {
    const device = makeDevice('active');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    const result = await svc.pauseDevice(WS_ID, DEV_ID);
    expect(result.status).toBe('paused');
    expect(device.save).toHaveBeenCalled();
  });

  it('pause: throws if device is not active', async () => {
    const device = makeDevice('paused');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    await expect(svc.pauseDevice(WS_ID, DEV_ID)).rejects.toThrow(BadRequestException);
  });

  it('unpause: transitions paused → active', async () => {
    const device = makeDevice('paused');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    const result = await svc.unpauseDevice(WS_ID, DEV_ID);
    expect(result.status).toBe('active');
    expect(device.save).toHaveBeenCalled();
  });

  it('revoke: transitions active → revoked', async () => {
    const device = makeDevice('active');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    const result = await svc.revokeDevice(WS_ID, DEV_ID);
    expect(result.status).toBe('revoked');
    expect(device.save).toHaveBeenCalled();
  });

  it('revoke: throws if device is already revoked', async () => {
    const device = makeDevice('revoked');
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(device) }),
    };
    const svc = buildService({ deviceModel: deviceModel as any });
    await expect(svc.revokeDevice(WS_ID, DEV_ID)).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// assignDeviceUser tests
// ---------------------------------------------------------------------------

describe('AttendanceDevicesService.assignDeviceUser', () => {
  it('calls updateMany on AttendanceEvent to set teamMemberId for matching (serial, deviceUserId) pairs', async () => {
    const updateManyMock = vi.fn().mockResolvedValue({ modifiedCount: 5 });
    const eventModel = {
      updateMany: updateManyMock,
      aggregate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const teamMemberModel = { updateOne: vi.fn().mockResolvedValue({}) };
    const svc = buildService({
      eventModel: eventModel as any,
      teamMemberModel: teamMemberModel as any,
    });

    const dto = {
      deviceSerial: 'ABC123',
      deviceUserId: 'U001',
      teamMemberId: '507f1f77bcf86cd799439011',
    };
    const result = await svc.assignDeviceUser('507f191e810c19729de860ea', dto);

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceSerial: 'ABC123',
        deviceUserId: 'U001',
        teamMemberId: null,
      }),
      { $set: expect.objectContaining({ teamMemberId: expect.anything() }) },
    );
    expect(result).toEqual({ updated: 5 });
  });

  it('adds biometricBinding to TeamMember via $addToSet (idempotent)', async () => {
    const teamMemberUpdateOne = vi.fn().mockResolvedValue({});
    const eventModel = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
      aggregate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const teamMemberModel = { updateOne: teamMemberUpdateOne };
    const svc = buildService({
      eventModel: eventModel as any,
      teamMemberModel: teamMemberModel as any,
    });

    const dto = {
      deviceSerial: 'SN001',
      deviceUserId: '42',
      teamMemberId: '507f1f77bcf86cd799439011',
    };
    await svc.assignDeviceUser('507f191e810c19729de860ea', dto);

    expect(teamMemberUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $addToSet: expect.objectContaining({
          biometricBindings: expect.objectContaining({
            deviceSerial: 'SN001',
            deviceUserId: '42',
          }),
        }),
      }),
    );
  });

  it('returns modifiedCount from updateMany', async () => {
    const eventModel = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 10 }),
      aggregate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue([]) }),
    };
    const teamMemberModel = { updateOne: vi.fn().mockResolvedValue({}) };
    const svc = buildService({
      eventModel: eventModel as any,
      teamMemberModel: teamMemberModel as any,
    });

    const dto = {
      deviceSerial: 'SN002',
      deviceUserId: '7',
      teamMemberId: '507f1f77bcf86cd799439011',
    };
    const result = await svc.assignDeviceUser('507f191e810c19729de860ea', dto);
    expect(result.updated).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// rotateIngestToken tests
// ---------------------------------------------------------------------------

describe('AttendanceDevicesService.rotateIngestToken', () => {
  const ownerId = '507f191e810c19729de860ab';

  function makeWorkspaceModel(attrs: {
    exists: boolean;
    ownerId?: string;
    currentToken?: string | null;
  }) {
    const ws = attrs.exists
      ? {
          _id: '507f191e810c19729de860ea',
          ownerId: attrs.ownerId ?? ownerId,
          attendanceIngestToken: attrs.currentToken ?? null,
          attendanceIngestTokenRotatedAt: null,
          save: vi.fn().mockResolvedValue(undefined),
        }
      : null;

    return {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(ws) }),
      }),
    };
  }

  it('generates a 64-char base64url token', async () => {
    const workspaceModel = makeWorkspaceModel({ exists: true, currentToken: 'oldtok' });
    const ingestService = { evictFromCache: vi.fn() };
    const svc = buildService({
      workspaceModel: workspaceModel as any,
      ingestService: ingestService as any,
    });

    const result = await svc.rotateIngestToken(
      '507f191e810c19729de860ea',
      ownerId,
      { confirm: true },
    );

    expect(typeof result.token).toBe('string');
    expect(result.token).toHaveLength(64);
    // base64url chars only: A-Z, a-z, 0-9, -, _
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('stores new token on workspace and sets attendanceIngestTokenRotatedAt', async () => {
    const ws = {
      ownerId,
      attendanceIngestToken: 'oldtoken',
      attendanceIngestTokenRotatedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceModel = {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(ws) }),
      }),
    };
    const ingestService = { evictFromCache: vi.fn() };
    const svc = buildService({
      workspaceModel: workspaceModel as any,
      ingestService: ingestService as any,
    });

    await svc.rotateIngestToken(
      '507f191e810c19729de860ea',
      ownerId,
      { confirm: true },
    );

    expect(ws.save).toHaveBeenCalled();
    expect(ws.attendanceIngestToken).not.toBe('oldtoken');
    expect(ws.attendanceIngestToken).toHaveLength(64);
    expect(ws.attendanceIngestTokenRotatedAt).toBeInstanceOf(Date);
  });

  it('calls ingestService.evictFromCache with old token', async () => {
    const workspaceModel = makeWorkspaceModel({
      exists: true,
      currentToken: 'the-old-token',
    });
    const ingestService = { evictFromCache: vi.fn() };
    const svc = buildService({
      workspaceModel: workspaceModel as any,
      ingestService: ingestService as any,
    });

    await svc.rotateIngestToken(
      '507f191e810c19729de860ea',
      ownerId,
      { confirm: true },
    );

    expect(ingestService.evictFromCache).toHaveBeenCalledWith('the-old-token');
  });

  it('throws ForbiddenException if requestUserId is not workspace owner', async () => {
    const workspaceModel = makeWorkspaceModel({ exists: true, ownerId: 'owner-abc' });
    const svc = buildService({ workspaceModel: workspaceModel as any });

    await expect(
      svc.rotateIngestToken(
        '507f191e810c19729de860ea',
        'different-user-id',
        { confirm: true },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws BadRequestException if confirm is false', async () => {
    const workspaceModel = makeWorkspaceModel({ exists: true });
    const svc = buildService({ workspaceModel: workspaceModel as any });

    await expect(
      svc.rotateIngestToken(
        '507f191e810c19729de860ea',
        ownerId,
        { confirm: false },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException if workspace not found', async () => {
    const workspaceModel = makeWorkspaceModel({ exists: false });
    const svc = buildService({ workspaceModel: workspaceModel as any });

    await expect(
      svc.rotateIngestToken(
        '507f191e810c19729de860ea',
        ownerId,
        { confirm: true },
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
