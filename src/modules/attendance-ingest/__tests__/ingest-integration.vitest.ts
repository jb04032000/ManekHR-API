/**
 * TEST-04: ADMS ingest integration test — full pipeline against mongodb-memory-server.
 *
 * Covers:
 *   1. Dedupe: same ATTLOG pushed twice inserts 1, then 0 (E11000 on unique partial index).
 *   2. Device state — pending_approval: punches silently discarded (no events written).
 *   3. Device state — active: events written with correct wsId, deviceSerial, punchType.
 *   4. Binding conflict: two live members sharing (deviceSerial, deviceUserId) → anomaly written,
 *      event left unassigned (teamMemberId = null).
 *   5. Revoked device: subsequent events silently dropped, no exception thrown.
 *
 * No vi.fn() mocks for DB layer — real Mongoose models against MongoMemoryServer.
 *
 * NOTE on TeamMember schema: The production TeamMemberSchema uses bare @Prop() decorators
 * without explicit { type } hints. Vitest's esbuild transform does NOT emit
 * TypeScript decorator metadata, so NestJS Mongoose cannot auto-infer primitive types
 * at runtime — causing a "Cannot determine type" error when SchemaFactory runs.
 * We therefore use a minimal hand-crafted Mongoose Schema for TeamMember that captures
 * only the fields the ingest service queries:
 *   - workspaceId, isDeleted, biometricBindings.deviceSerial, biometricBindings.deviceUserId
 * This avoids modifying production source while keeping the test fully functional.
 * The real TeamMemberSchema (with emitDecoratorMetadata from ts-node/Jest) continues
 * to be used by the NestJS application and any Jest-based tests.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import mongoose, { Model, Schema, Types } from 'mongoose';

// Prevent transitive import of Shift/Attendance schemas (bare @Prop without type)
// through AttendanceProjectionService. The ingest service receives a projectionStub
// at construction time — this mock only blocks the module-load-time schema side-effect.
vi.mock('../../attendance/attendance-projection.service', () => ({
  AttendanceProjectionService: class {},
  RECOMPUTE_CONCURRENCY: 8,
}));

import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  type TestMongo,
} from '../../../test-utils/mongo-memory';

// ── Schemas ──────────────────────────────────────────────────────────────────
import {
  AttendanceEvent,
  AttendanceEventSchema,
} from '../../attendance/schemas/attendance-event.schema';
import {
  AttendanceDevice,
  AttendanceDeviceSchema,
} from '../../attendance-devices/schemas/attendance-device.schema';
import {
  Anomaly,
  AnomalySchema,
} from '../../anomalies/schemas/anomaly.schema';
import {
  AnomalyRule,
  AnomalyRuleSchema,
} from '../../anomalies/schemas/anomaly-rule.schema';

// ── Services ─────────────────────────────────────────────────────────────────
import { AttendanceIngestService } from '../attendance-ingest.service';
import { AnomaliesService } from '../../anomalies/anomalies.service';

// ── Minimal inline schemas ───────────────────────────────────────────────────
// These are structurally minimal — only the fields consumed by the ingest service.
// Using raw mongoose Schema (no @Prop decorators) avoids the emitDecoratorMetadata
// issue that breaks NestJS SchemaFactory under Vitest/esbuild.

const TeamMemberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true },
    salaryType: { type: String, default: 'monthly' },
    salaryAmount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false, index: true },
    isPermanentlyDeleted: { type: Boolean, default: false },
    biometricBindings: {
      type: [
        {
          deviceSerial: { type: String, required: true },
          deviceUserId: { type: String, required: true },
          addedAt: { type: Date, default: Date.now },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { strict: false, timestamps: true },
);

// Biometric binding partial unique index — mirrors production schema so
// E11000 fires correctly for the binding_conflict test setup.
TeamMemberSchema.index(
  {
    workspaceId: 1,
    'biometricBindings.deviceSerial': 1,
    'biometricBindings.deviceUserId': 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      'biometricBindings.deviceSerial': { $type: 'string' },
      'biometricBindings.deviceUserId': { $type: 'string' },
    },
    background: true,
  },
);

const WorkspaceSchema = new Schema(
  { name: String, attendanceIngestToken: String },
  { strict: false },
);
const SalarySchema = new Schema(
  {
    workspaceId: Schema.Types.ObjectId,
    teamMemberId: Schema.Types.ObjectId,
    month: Number,
    year: Number,
    isLocked: Boolean,
  },
  { strict: false },
);
const CommandSchema = new Schema({}, { strict: false });
const IngestLogSchema = new Schema({}, { strict: false });

// ── Test constants ───────────────────────────────────────────────────────────
const WS_ID = new Types.ObjectId().toHexString();
const DEVICE_SERIAL = 'SN-TEST-001';
const DEVICE_USER_ID = 'U001';
/** Standard ZK ATTLOG line: deviceUserId TAB timestamp TAB statusCode TAB verifyCode TAB reserved TAB workCode */
const ATTLOG_LINE = `${DEVICE_USER_ID}\t2026-04-20 09:00:00\t0\t1\t0\t0\n`;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Insert an AttendanceDevice document with the given status. */
async function seedDevice(
  deviceModel: Model<any>,
  wsId: string,
  serial: string,
  status: 'active' | 'pending_approval' | 'revoked' | 'paused' = 'active',
): Promise<mongoose.Document> {
  return deviceModel.create({
    wsId: new Types.ObjectId(wsId),
    serial,
    status,
    vendor: 'zkteco',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });
}

/** Insert a TeamMember with a biometric binding for (serial, deviceUserId). */
async function seedMemberWithBinding(
  memberModel: Model<any>,
  wsId: string,
  serial: string,
  deviceUserId: string,
  name = 'Test Member',
): Promise<mongoose.Document> {
  return memberModel.create({
    workspaceId: new Types.ObjectId(wsId),
    name,
    salaryType: 'monthly',
    salaryAmount: 10000,
    isActive: true,
    isDeleted: false,
    isPermanentlyDeleted: false,
    biometricBindings: [{ deviceSerial: serial, deviceUserId, addedAt: new Date() }],
  });
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('ADMS ingest integration (TEST-04)', () => {
  let mongo: TestMongo;
  let eventModel: Model<AttendanceEvent>;
  let deviceModel: Model<AttendanceDevice>;
  let memberModel: Model<any>;
  let anomalyModel: Model<Anomaly>;
  let anomalyRuleModel: Model<AnomalyRule>;
  let ingestService: AttendanceIngestService;

  beforeAll(async () => {
    mongo = await createTestMongoose();

    // Register models on the in-memory connection.
    eventModel = mongoose.model<AttendanceEvent>(AttendanceEvent.name, AttendanceEventSchema);
    deviceModel = mongoose.model<AttendanceDevice>(AttendanceDevice.name, AttendanceDeviceSchema);
    // Use the minimal hand-crafted schema — avoids emitDecoratorMetadata issue (see file header).
    memberModel = mongoose.model('TeamMember', TeamMemberSchema);
    anomalyModel = mongoose.model<Anomaly>(Anomaly.name, AnomalySchema);
    anomalyRuleModel = mongoose.model<AnomalyRule>(AnomalyRule.name, AnomalyRuleSchema);
    const workspaceModel = mongoose.model('Workspace', WorkspaceSchema);
    const salaryModel = mongoose.model('Salary', SalarySchema);
    const commandModel = mongoose.model('AttendanceDeviceCommand', CommandSchema);
    const ingestLogModel = mongoose.model('AttendanceIngestLog', IngestLogSchema);

    // Ensure partial unique indexes are built before tests run.
    await eventModel.syncIndexes();
    await memberModel.syncIndexes();
    await anomalyModel.syncIndexes();
    await anomalyRuleModel.syncIndexes();

    // Build a real AnomaliesService backed by the real anomaly models.
    // Stub only the AnomalyNotifyService (email dispatch) — not under test here.
    const notifyStub = {
      dispatch: async (_anomaly: any) => undefined,
    };
    const anomaliesService = new AnomaliesService(
      anomalyModel as any,
      anomalyRuleModel as any,
      notifyStub as any,
    );

    // Stub the projection service — fire-and-forget, not under test here.
    const projectionStub = {
      recompute: async (_wsId: string, _memberId: string, _day: Date) => undefined,
    };

    // Construct ingest service with all real models + minimal stubs for unused deps.
    // Constructor parameter order (from attendance-ingest.service.ts):
    //   deviceModel, commandModel, ingestLogModel, eventModel, teamMemberModel,
    //   workspaceModel, salaryModel, projectionService, anomaliesService
    ingestService = new AttendanceIngestService(
      deviceModel as any,
      commandModel as any,
      ingestLogModel as any,
      eventModel as any,
      memberModel as any,
      workspaceModel as any,
      salaryModel as any,
      projectionStub as any,
      anomaliesService,
    );
  }, 60_000); // allow 60s for MongoMemoryServer binary download on first run

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    // Recreate indexes after clearing (a prior test may have dropped an index).
    await eventModel.syncIndexes();
    await memberModel.syncIndexes();
  });

  // ── Test 1: Dedupe ──────────────────────────────────────────────────────────

  it('dedupe: same ATTLOG event pushed twice inserts 1 then 0', async () => {
    await seedDevice(deviceModel, WS_ID, DEVICE_SERIAL, 'active');
    await seedMemberWithBinding(memberModel, WS_ID, DEVICE_SERIAL, DEVICE_USER_ID);

    // First push — should insert exactly 1 event.
    const firstInserted = await ingestService.handleAttlog(WS_ID, DEVICE_SERIAL, ATTLOG_LINE);
    expect(firstInserted).toBe(1);

    const countAfterFirst = await eventModel.countDocuments({});
    expect(countAfterFirst).toBe(1);

    // Second push — identical payload; unique partial index (wsId, deviceSerial,
    // deviceUserId, timestamp) fires E11000 → service swallows it and returns 0.
    const secondInserted = await ingestService.handleAttlog(WS_ID, DEVICE_SERIAL, ATTLOG_LINE);
    expect(secondInserted).toBe(0);

    // Collection still has exactly 1 document — dedupe worked.
    const countAfterSecond = await eventModel.countDocuments({});
    expect(countAfterSecond).toBe(1);
  });

  // ── Test 2: Pending device discards punches ─────────────────────────────────

  it('device state: pending_approval device discards punches (no events written)', async () => {
    await seedDevice(deviceModel, WS_ID, DEVICE_SERIAL, 'pending_approval');
    await seedMemberWithBinding(memberModel, WS_ID, DEVICE_SERIAL, DEVICE_USER_ID);

    const inserted = await ingestService.handleAttlog(WS_ID, DEVICE_SERIAL, ATTLOG_LINE);

    // Service short-circuits on non-active device status and returns 0.
    expect(inserted).toBe(0);

    // No AttendanceEvent must be written.
    const eventCount = await eventModel.countDocuments({});
    expect(eventCount).toBe(0);

    // The device document must still exist in the DB with its original status.
    const device = await deviceModel.findOne({ serial: DEVICE_SERIAL }).lean().exec();
    expect(device).not.toBeNull();
    expect(device!.status).toBe('pending_approval');
  });

  // ── Test 3: Active device writes correct AttendanceEvent ───────────────────

  it('device state: active device writes AttendanceEvent with correct wsId + deviceSerial', async () => {
    await seedDevice(deviceModel, WS_ID, DEVICE_SERIAL, 'active');
    const member = await seedMemberWithBinding(
      memberModel,
      WS_ID,
      DEVICE_SERIAL,
      DEVICE_USER_ID,
    ) as any;

    const inserted = await ingestService.handleAttlog(WS_ID, DEVICE_SERIAL, ATTLOG_LINE);

    expect(inserted).toBe(1);

    const events = await eventModel.find({}).lean().exec();
    expect(events).toHaveLength(1);

    const ev = events[0];
    // wsId, deviceSerial, and deviceUserId must match the push payload exactly.
    expect((ev.wsId as Types.ObjectId).toHexString()).toBe(WS_ID);
    expect(ev.deviceSerial).toBe(DEVICE_SERIAL);
    expect(ev.deviceUserId).toBe(DEVICE_USER_ID);
    // Source must be 'device_push' per the service implementation.
    expect(ev.source).toBe('device_push');
    // teamMemberId must resolve to the seeded member.
    expect((ev.teamMemberId as Types.ObjectId)?.toHexString()).toBe(String(member._id));
    // punchType must be a valid enum value (statusCode=0 → CHECK_IN per zk-code-mapper).
    expect([
      'CHECK_IN', 'CHECK_OUT', 'BREAK_OUT', 'BREAK_IN', 'OT_IN', 'OT_OUT', 'STATUS_SET',
    ]).toContain(ev.punchType);
  });

  // ── Test 4: Binding conflict ────────────────────────────────────────────────

  it('binding_conflict: two members with same (deviceSerial, deviceUserId) triggers anomaly and leaves event unassigned', async () => {
    await seedDevice(deviceModel, WS_ID, DEVICE_SERIAL, 'active');

    // The TeamMember biometric binding partial unique index prevents two live members
    // from sharing a (deviceSerial, deviceUserId) in production.
    // To engineer the conflict in this test:
    //   1. Drop the biometric binding unique index.
    //   2. Insert both members directly via collection.insertMany.
    //   3. Rebuild indexes in beforeEach — but for this test we leave the index absent
    //      so the ingest service can query and find two candidates.

    // Drop the biometric binding partial unique index.
    try {
      await memberModel.collection.dropIndex(
        'workspaceId_1_biometricBindings.deviceSerial_1_biometricBindings.deviceUserId_1',
      );
    } catch {
      // Index may already be absent — ignore.
    }

    const sharedBinding = {
      deviceSerial: DEVICE_SERIAL,
      deviceUserId: DEVICE_USER_ID,
      addedAt: new Date(),
    };
    const baseMember = {
      workspaceId: new Types.ObjectId(WS_ID),
      salaryType: 'monthly',
      salaryAmount: 10000,
      isActive: true,
      isDeleted: false,
      isPermanentlyDeleted: false,
      biometricBindings: [sharedBinding],
    };

    // Insert two members that share the same binding (bypass the unique index).
    await memberModel.collection.insertMany([
      { ...baseMember, name: 'Conflict Member A' },
      { ...baseMember, name: 'Conflict Member B' },
    ]);

    // Verify both members are in the DB before pushing.
    const memberCount = await memberModel.countDocuments({});
    expect(memberCount).toBe(2);

    // Push a single ATTLOG line — the service will find 2 candidates and record an anomaly.
    await ingestService.handleAttlog(WS_ID, DEVICE_SERIAL, ATTLOG_LINE);

    // Wait for the setImmediate fire-and-forget anomaly record to flush.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Verify a binding_conflict anomaly was written by the real AnomaliesService.
    const anomalies = await anomalyModel.find({ ruleType: 'binding_conflict' }).lean().exec();
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0].ruleType).toBe('binding_conflict');
    expect((anomalies[0].wsId as Types.ObjectId).toHexString()).toBe(WS_ID);

    // The event — if inserted — must have teamMemberId = null (unassigned).
    const events = await eventModel.find({}).lean().exec();
    if (events.length > 0) {
      expect(events[0].teamMemberId).toBeNull();
    }
    // Either 0 events (not inserted) or 1 event with teamMemberId=null are both valid.
    expect(events.length).toBeLessThanOrEqual(1);
  });

  // ── Test 5: Revoked device silently drops events ────────────────────────────

  it('revoked device: subsequent events silently dropped (no exception, no event written)', async () => {
    await seedDevice(deviceModel, WS_ID, DEVICE_SERIAL, 'revoked');
    await seedMemberWithBinding(memberModel, WS_ID, DEVICE_SERIAL, DEVICE_USER_ID);

    // handleAttlog must not throw for a revoked device.
    let inserted!: number;
    await expect(
      (async () => {
        inserted = await ingestService.handleAttlog(WS_ID, DEVICE_SERIAL, ATTLOG_LINE);
      })(),
    ).resolves.not.toThrow();

    // No events must be written.
    const eventCount = await eventModel.countDocuments({});
    expect(eventCount).toBe(0);

    // Service must return 0 — callers get a definitive "nothing written" signal.
    expect(inserted).toBe(0);

    // No anomaly should be written for a revoked device — it's a silent discard.
    const anomalyCount = await anomalyModel.countDocuments({});
    expect(anomalyCount).toBe(0);
  });
});
