/**
 * Vitest unit tests for AttendanceIngestService.
 *
 * Strategy: Mock all NestJS/Mongoose schema modules so decorator evaluation
 * is skipped, then import the service and construct it with plain mock objects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock NestJS + Mongoose decorator packages before any service import so
// @Prop / @Schema / @Injectable decorators are no-ops during test collection.
// ---------------------------------------------------------------------------
vi.mock('@nestjs/mongoose', () => ({
  InjectModel: () => () => {},
  Prop: () => () => {},
  Schema: () => () => {},
  SchemaFactory: { createForClass: () => ({}) },
  MongooseModule: { forFeature: () => ({}) },
}));

vi.mock('@nestjs/common', () => ({
  Injectable: () => () => {},
  Logger: class {
    log() {}
    warn() {}
    error() {}
  },
  Module: () => () => {},
  Controller: () => () => {},
  Get: () => () => {},
  Post: () => () => {},
  Param: () => () => {},
  Query: () => () => {},
  Req: () => () => {},
  Res: () => () => {},
  UsePipes: () => () => {},
  ValidationPipe: class {},
}));

// Mock schema files to plain objects — avoids Mongoose decorator errors
vi.mock('../attendance-devices/schemas/attendance-device.schema', () => ({
  AttendanceDevice: class {},
  AttendanceDeviceSchema: {},
}));

vi.mock(
  '../attendance-devices/schemas/attendance-device-command.schema',
  () => ({
    AttendanceDeviceCommand: class {},
    AttendanceDeviceCommandSchema: {},
  }),
);

vi.mock('./schemas/attendance-ingest-log.schema', () => ({
  AttendanceIngestLog: class {},
  AttendanceIngestLogSchema: {},
}));

vi.mock('../attendance/schemas/attendance-event.schema', () => ({
  AttendanceEvent: class {},
  AttendanceEventSchema: {},
}));

vi.mock('../attendance/attendance-projection.service', () => ({
  AttendanceProjectionService: class {
    recompute = vi.fn().mockResolvedValue(undefined);
  },
  RECOMPUTE_CONCURRENCY: 8,
}));

vi.mock('../salary/schemas/salary.schema', () => ({
  Salary: class {},
  SalarySchema: { index: () => {} },
}));

vi.mock('../anomalies/anomalies.service', () => ({
  AnomaliesService: class {
    record = vi.fn().mockResolvedValue(undefined);
  },
}));

// Now import the service — decorators are all no-ops
import { AttendanceIngestService } from './attendance-ingest.service';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeWorkspaceModel(token: string | null, wsId = 'ws123') {
  return {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi
            .fn()
            .mockResolvedValue(
              token ? { _id: wsId, attendanceIngestToken: token } : null,
            ),
        }),
      }),
    }),
  };
}

function makeDeviceModel(device: any) {
  return {
    findOne: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(device),
    }),
    create: vi
      .fn()
      .mockResolvedValue({ _id: 'dev1', status: 'pending_approval' }),
    updateOne: vi.fn().mockResolvedValue({}),
  };
}

function makeEventModel(insertResult: any[], throwErr?: any) {
  return {
    insertMany: throwErr
      ? vi.fn().mockRejectedValue(throwErr)
      : vi.fn().mockResolvedValue(insertResult),
  };
}

function makeCommandModel(command: any) {
  return {
    findOneAndUpdate: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(command),
    }),
  };
}

function makeIngestLogModel() {
  return { create: vi.fn().mockResolvedValue({}) };
}

function makeTeamMemberModel(member: any) {
  const chainMock = {
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(member ? [member] : []),
  };
  return {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(member),
        }),
      }),
    }),
    find: vi.fn().mockReturnValue(chainMock),
  };
}

function makeProjectionService() {
  return { recompute: vi.fn().mockResolvedValue(undefined) };
}

function makeSalaryModel() {
  return {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      }),
    }),
  };
}

function makeAnomaliesService() {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

function buildService(overrides: {
  workspaceModel?: any;
  deviceModel?: any;
  eventModel?: any;
  commandModel?: any;
  ingestLogModel?: any;
  teamMemberModel?: any;
  salaryModel?: any;
  projectionService?: any;
  anomaliesService?: any;
}) {
  return new AttendanceIngestService(
    overrides.deviceModel ?? makeDeviceModel(null),
    overrides.commandModel ?? makeCommandModel(null),
    overrides.ingestLogModel ?? makeIngestLogModel(),
    overrides.eventModel ?? makeEventModel([]),
    overrides.teamMemberModel ?? makeTeamMemberModel(null),
    overrides.workspaceModel ?? makeWorkspaceModel(null),
    overrides.salaryModel ?? makeSalaryModel(),
    overrides.projectionService ?? makeProjectionService(),
    overrides.anomaliesService ?? makeAnomaliesService(),
  );
}

const SAMPLE_ATTLOG = '1001\t2026-04-18 09:01:23\t0\t1\t0\t0\t';

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------
describe('AttendanceIngestService.resolveToken', () => {
  it('returns wsId string for a known token', async () => {
    const token = 'abc123validtoken1234567890abcdefghijklmnopqrstuv1234';
    const svc = buildService({
      workspaceModel: makeWorkspaceModel(token, 'ws999'),
    });

    const result = await svc.resolveToken(token);
    expect(result).toBe('ws999');
  });

  it('returns null for an unknown token', async () => {
    const svc = buildService({ workspaceModel: makeWorkspaceModel(null) });
    const result = await svc.resolveToken('unknowntoken');
    expect(result).toBeNull();
  });

  it('returns cached result within 60s TTL without hitting DB again', async () => {
    const token = 'cachedtoken12345678901234567890123456789012345678901';
    const wsModel = makeWorkspaceModel(token, 'wsCached');
    const svc = buildService({ workspaceModel: wsModel });

    await svc.resolveToken(token);
    const result = await svc.resolveToken(token);

    expect(result).toBe('wsCached');
    // DB hit only once — second call served from cache
    expect(wsModel.findOne).toHaveBeenCalledTimes(1);
  });

  it('evicts cache entry on evictFromCache(token)', async () => {
    const token = 'evicttoken123456789012345678901234567890123456789012';
    const wsModel = makeWorkspaceModel(token, 'wsEvict');
    const svc = buildService({ workspaceModel: wsModel });

    await svc.resolveToken(token);
    svc.evictFromCache(token);
    await svc.resolveToken(token);

    // Two DB hits — cache was cleared between calls
    expect(wsModel.findOne).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// ingestBatch (via handleAttlog)
// ---------------------------------------------------------------------------
describe('AttendanceIngestService.ingestBatch', () => {
  it('calls insertMany with ordered:false on the event model', async () => {
    const eventModel = makeEventModel([{ _id: 'e1' }]);
    const activeDevice = { _id: 'dev1', status: 'active' };
    const deviceModel = {
      findOne: vi
        .fn()
        .mockReturnValue({ exec: vi.fn().mockResolvedValue(activeDevice) }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    await svc.handleAttlog('507f1f77bcf86cd799439011', 'SN001', SAMPLE_ATTLOG);

    expect(eventModel.insertMany).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ ordered: false }),
    );
  });

  it('returns inserted count (not total submitted) on dup-key BulkWriteError', async () => {
    const bulkErr = Object.assign(new Error('E11000'), {
      name: 'MongoBulkWriteError',
      code: 11000,
      result: { nInserted: 0 },
      insertedCount: 0,
    });
    const eventModel = makeEventModel([], bulkErr);
    const activeDevice = { _id: 'dev1', status: 'active' };
    const deviceModel = {
      findOne: vi
        .fn()
        .mockReturnValue({ exec: vi.fn().mockResolvedValue(activeDevice) }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    const count = await svc.handleAttlog(
      '507f1f77bcf86cd799439011',
      'SN001',
      SAMPLE_ATTLOG,
    );
    expect(count).toBe(0);
  });

  it('does not throw when all records are duplicates (E11000)', async () => {
    const bulkErr = Object.assign(new Error('E11000'), {
      name: 'MongoBulkWriteError',
      code: 11000,
      result: { nInserted: 0 },
      insertedCount: 0,
    });
    const eventModel = makeEventModel([], bulkErr);
    const activeDevice = { _id: 'dev1', status: 'active' };
    const deviceModel = {
      findOne: vi
        .fn()
        .mockReturnValue({ exec: vi.fn().mockResolvedValue(activeDevice) }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    await expect(
      svc.handleAttlog('507f1f77bcf86cd799439011', 'SN001', SAMPLE_ATTLOG),
    ).resolves.toBeDefined();
  });

  it('increments device stats.totalEvents by inserted count', async () => {
    const eventModel = makeEventModel([{ _id: 'e1' }]);
    const activeDevice = { _id: 'dev1', status: 'active' };
    const deviceModel = {
      findOne: vi
        .fn()
        .mockReturnValue({ exec: vi.fn().mockResolvedValue(activeDevice) }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    await svc.handleAttlog('507f1f77bcf86cd799439011', 'SN001', SAMPLE_ATTLOG);

    expect(deviceModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'dev1' }),
      expect.objectContaining({ $inc: { 'stats.totalEvents': 1 } }),
    );
  });
});

// ---------------------------------------------------------------------------
// auto-register + status gating
// ---------------------------------------------------------------------------
describe('AttendanceIngestService auto-register', () => {
  const WS_ID = '507f1f77bcf86cd799439011';

  it('creates AttendanceDevice with status=pending_approval on first unknown SN', async () => {
    const deviceModel = {
      findOne: vi
        .fn()
        .mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
      create: vi
        .fn()
        .mockResolvedValue({ _id: 'newDev', status: 'pending_approval' }),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    const svc = buildService({ deviceModel });

    await svc.handleAttlog(WS_ID, 'UNKNOWN_SN', SAMPLE_ATTLOG);

    expect(deviceModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending_approval',
        serial: 'UNKNOWN_SN',
      }),
    );
  });

  it('does NOT persist ATTLOG events when device status is pending_approval', async () => {
    const eventModel = makeEventModel([]);
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({
        exec: vi
          .fn()
          .mockResolvedValue({ _id: 'dev1', status: 'pending_approval' }),
      }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    const count = await svc.handleAttlog(WS_ID, 'SN001', SAMPLE_ATTLOG);

    expect(count).toBe(0);
    expect(eventModel.insertMany).not.toHaveBeenCalled();
  });

  it('does NOT persist ATTLOG events when device status is revoked', async () => {
    const eventModel = makeEventModel([]);
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'dev1', status: 'revoked' }),
      }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    const count = await svc.handleAttlog(WS_ID, 'SN001', SAMPLE_ATTLOG);

    expect(count).toBe(0);
    expect(eventModel.insertMany).not.toHaveBeenCalled();
  });

  it('does NOT persist ATTLOG events when device status is paused', async () => {
    const eventModel = makeEventModel([]);
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'dev1', status: 'paused' }),
      }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    const count = await svc.handleAttlog(WS_ID, 'SN001', SAMPLE_ATTLOG);

    expect(count).toBe(0);
    expect(eventModel.insertMany).not.toHaveBeenCalled();
  });

  it('persists events when device status is active', async () => {
    const eventModel = makeEventModel([{ _id: 'e1' }]);
    const deviceModel = {
      findOne: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ _id: 'dev1', status: 'active' }),
      }),
      updateOne: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
    };
    const svc = buildService({ eventModel, deviceModel });

    const count = await svc.handleAttlog(WS_ID, 'SN001', SAMPLE_ATTLOG);

    expect(count).toBe(1);
    expect(eventModel.insertMany).toHaveBeenCalled();
  });
});
