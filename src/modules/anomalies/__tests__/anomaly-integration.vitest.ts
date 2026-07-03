import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  TestMongo,
} from '../../../test-utils/mongo-memory';

import { Anomaly, AnomalySchema } from '../schemas/anomaly.schema';
import { AnomalyRule, AnomalyRuleSchema } from '../schemas/anomaly-rule.schema';
// Attendance schema uses a union prop type that causes NestJS @Prop decorator resolution
// issues at import time. Use a minimal inline schema for the test instead — the production
// schema's field decorators require the full NestJS module bootstrap context.
const AttendanceTestSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    teamMemberId: { type: Schema.Types.ObjectId, required: true },
    date: { type: Date, required: true },
    status: { type: String, required: true },
  },
  { timestamps: true },
);
// Add the same compound unique index the production schema has
AttendanceTestSchema.index({ workspaceId: 1, teamMemberId: 1, date: 1 }, { unique: true });

import { AnomaliesService } from '../anomalies.service';
import { AnomalyDetectionService } from '../anomaly-detection.service';

describe('Anomaly detection integration (TEST-06)', () => {
  let mongo: TestMongo;
  let anomalyModel: mongoose.Model<any>;
  let ruleModel: mongoose.Model<any>;
  let attendanceModel: mongoose.Model<any>;
  let anomalies: AnomaliesService;
  let detection: AnomalyDetectionService;

  const wsId = new Types.ObjectId().toString();
  const memberId = new Types.ObjectId().toString();
  const deviceA = 'SN-TEST-AAA';
  const deviceB = 'SN-TEST-BBB';

  beforeAll(async () => {
    mongo = await createTestMongoose();

    // Register models on the shared connection (model() is idempotent if already registered)
    anomalyModel = mongoose.models[Anomaly.name]
      ? mongoose.model(Anomaly.name)
      : mongoose.model(Anomaly.name, AnomalySchema);

    ruleModel = mongoose.models[AnomalyRule.name]
      ? mongoose.model(AnomalyRule.name)
      : mongoose.model(AnomalyRule.name, AnomalyRuleSchema);

    attendanceModel = mongoose.models['Attendance']
      ? mongoose.model('Attendance')
      : mongoose.model('Attendance', AttendanceTestSchema);

    // Ensure indexes are created on the in-memory DB
    await anomalyModel.syncIndexes();
    await ruleModel.syncIndexes();
    await attendanceModel.syncIndexes();

    // Stub AnomalyNotifyService — no outbound mail/push during tests
    const notifyStub = { dispatch: vi.fn().mockResolvedValue(undefined) };

    const postHogStub = { capture: vi.fn() } as any;
    anomalies = new AnomaliesService(
      anomalyModel as any,
      ruleModel as any,
      notifyStub as any,
      postHogStub,
    );

    // Stub HolidaysService — no holidays in test workspace
    const holidaysStub = { findByDate: vi.fn().mockResolvedValue(null) };

    // IMPORTANT: Use the SAME AnomalyDetectionService instance across all tests within a
    // describe block so the in-memory LRU rapidDupWindow accumulates across calls (D-12).
    detection = new AnomalyDetectionService(holidaysStub as any, attendanceModel as any, anomalies);
  });

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    // Re-sync indexes after collection clear (indexes survive clearCollections but verify)
    await anomalyModel.syncIndexes();
  });

  /**
   * Flush the fire-and-forget setImmediate dispatch in AnomaliesService.record
   * before running assertions on the DB.
   */
  const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(() => resolve()));

  // ─── rapid_dup cross-batch (D-12) ────────────────────────────────────────────

  describe('rapid_dup cross-batch (D-12)', () => {
    it('fires exactly 1 rapid_dup anomaly when 5 detectOnEvent calls share the same (member, device) within 10s', async () => {
      // Re-create detection with a fresh LRU cache for this describe block so prior
      // beforeEach state doesn't bleed in.
      const freshDetection = new AnomalyDetectionService(
        { findByDate: vi.fn().mockResolvedValue(null) } as any,
        attendanceModel as any,
        anomalies,
      );

      const base = new Date('2026-04-20T09:00:00Z').getTime();

      // 5 separate awaited calls on the SAME service instance — LRU accumulates
      for (let i = 0; i < 5; i++) {
        const ts = new Date(base + i * 1000);
        await freshDetection.detectOnEvent(
          {
            wsId,
            teamMemberId: memberId,
            deviceSerial: deviceA,
            timestamp: ts,
          },
          ts, // serverReceiptTime matches event timestamp → no time_travel skew
        );
      }

      // Wait for the fire-and-forget dispatch to complete before querying
      await tick();

      const count = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'rapid_dup',
      });

      // The 5th call crosses the RAPID_DUP_THRESHOLD (>= 5) and fires exactly one anomaly.
      // rapid_dup is NOT in DEDUPE_RULE_TYPES so subsequent calls beyond the 5th could fire
      // additional records — but we only call exactly 5 times here.
      expect(count).toBe(1);
    });

    it('does NOT fire when 5 events span > 10 seconds (sliding window evicts earliest)', async () => {
      const freshDetection = new AnomalyDetectionService(
        { findByDate: vi.fn().mockResolvedValue(null) } as any,
        attendanceModel as any,
        anomalies,
      );

      const base = new Date('2026-04-20T10:00:00Z').getTime();
      // Offsets: t=0, t=3s, t=6s, t=9s, t=12s
      // At t=12s the sliding 10s window starts at t=2s, evicting t=0. Window has [t=3s,t=6s,t=9s,t=12s]=4 items → no trigger.
      const offsets = [0, 3_000, 6_000, 9_000, 12_000];

      for (const offset of offsets) {
        const ts = new Date(base + offset);
        await freshDetection.detectOnEvent(
          { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: ts },
          ts,
        );
      }

      await tick();

      const count = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'rapid_dup',
      });

      expect(count).toBe(0);
    });

    it('separate device serials do not cumulate: 3 on deviceA + 2 on deviceB → no rapid_dup fires', async () => {
      const freshDetection = new AnomalyDetectionService(
        { findByDate: vi.fn().mockResolvedValue(null) } as any,
        attendanceModel as any,
        anomalies,
      );

      const base = new Date('2026-04-20T11:00:00Z').getTime();

      // 3 calls for deviceA
      for (let i = 0; i < 3; i++) {
        const ts = new Date(base + i * 500);
        await freshDetection.detectOnEvent(
          { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: ts },
          ts,
        );
      }

      // 2 calls for deviceB (different LRU key)
      for (let i = 0; i < 2; i++) {
        const ts = new Date(base + 2_000 + i * 500);
        await freshDetection.detectOnEvent(
          { wsId, teamMemberId: memberId, deviceSerial: deviceB, timestamp: ts },
          ts,
        );
      }

      await tick();

      const count = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'rapid_dup',
      });

      // Neither deviceA (3 calls) nor deviceB (2 calls) reaches the threshold of 5
      expect(count).toBe(0);
    });
  });

  // ─── time_travel dedupe (H4-02 D-11) ─────────────────────────────────────────

  describe('time_travel dedupe (H4-02 D-11)', () => {
    it('3 replayed old events on the same UTC date produce ≤ 1 unacknowledged time_travel anomaly', async () => {
      // eventTs is 2 days before serverTs → |delta| ≫ 10 minutes → time_travel fires
      const eventTs = new Date('2026-04-18T09:00:00Z');
      const serverTs = new Date('2026-04-20T09:00:00Z');

      for (let i = 0; i < 3; i++) {
        await detection.detectOnEvent(
          { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: eventTs },
          serverTs,
        );
      }

      await tick();

      const unacknowledgedCount = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'time_travel',
        acknowledged: false,
      });

      // DEDUPE_RULE_TYPES now includes 'time_travel' (D-11 fix in H4-02).
      // Same contextKey (member:device:2026-04-18) → dedupe gate blocks all but the first insert.
      expect(unacknowledgedCount).toBe(1);
    });

    it('replayed punches spanning two different UTC dates produce 2 separate anomalies', async () => {
      // Two different event dates → two different contextKeys → no dedup → 2 records
      const day1Ts = new Date('2026-04-18T09:00:00Z');
      const day2Ts = new Date('2026-04-19T09:00:00Z');
      const serverTs = new Date('2026-04-20T09:00:00Z');

      await detection.detectOnEvent(
        { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: day1Ts },
        serverTs,
      );
      await detection.detectOnEvent(
        { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: day2Ts },
        serverTs,
      );

      await tick();

      const total = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'time_travel',
      });

      expect(total).toBe(2);
    });

    it('after acknowledging the first time_travel anomaly, a new replay on the same day creates a fresh record', async () => {
      const eventTs = new Date('2026-04-18T09:00:00Z');
      const serverTs = new Date('2026-04-20T09:00:00Z');

      // Insert the first anomaly
      await detection.detectOnEvent(
        { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: eventTs },
        serverTs,
      );
      await tick();

      // Mark it acknowledged — dedupe gate only blocks when acknowledged === false
      await anomalyModel.updateMany(
        { wsId: new Types.ObjectId(wsId), ruleType: 'time_travel' },
        { $set: { acknowledged: true } },
      );

      // Replay the same punch — should pass dedupe gate (no unacknowledged record for that contextKey)
      await detection.detectOnEvent(
        { wsId, teamMemberId: memberId, deviceSerial: deviceA, timestamp: eventTs },
        serverTs,
      );
      await tick();

      const total = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'time_travel',
      });
      const unack = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'time_travel',
        acknowledged: false,
      });

      // 2 total: the originally-acknowledged record + the newly created fresh record
      expect(total).toBe(2);
      // 1 new unacknowledged record after the second replay
      expect(unack).toBe(1);
    });
  });

  // ─── missed_streak dedupe ─────────────────────────────────────────────────────

  describe('missed_streak dedupe', () => {
    it('zero attendance rows across 3 consecutive working days triggers exactly 1 missed_streak anomaly', async () => {
      // referenceDate = 2026-04-22 (Wednesday); shift working Mon-Fri; no holidays stubbed; no attendance seeded
      const shift = {
        startTime: '09:00',
        endTime: '18:00',
        workingDays: [1, 2, 3, 4, 5], // Mon(1) through Fri(5)
      };

      const result = await detection.checkMissedStreak(
        wsId,
        memberId,
        shift,
        new Date('2026-04-22T00:00:00Z'),
      );

      // Streak must be detected (at least 3 working days missing)
      expect(result).not.toBeNull();
      expect(result.streakLength).toBeGreaterThanOrEqual(3);
      expect(result.missingDays.length).toBeGreaterThanOrEqual(3);

      // Simulate what the cron job would do: call anomalies.record twice (first normal, second duplicate)
      const contextKey = `${memberId}:streak:${result.missingDays[result.missingDays.length - 1].slice(0, 10)}`;

      // First call — should insert
      await anomalies.record({
        wsId,
        ruleType: 'missed_streak',
        severity: 'medium',
        teamMemberId: memberId,
        deviceSerial: null,
        context: { streakLength: result.streakLength, missingDays: result.missingDays },
        contextKey,
      });

      // Second call with same contextKey — dedupe gate must block
      await anomalies.record({
        wsId,
        ruleType: 'missed_streak',
        severity: 'medium',
        teamMemberId: memberId,
        deviceSerial: null,
        context: { streakLength: result.streakLength },
        contextKey,
      });

      const count = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'missed_streak',
      });

      // Only 1 record — second call is deduplicated by the contextKey gate
      expect(count).toBe(1);
    });

    it('returns null when member has at least one attendance row within the 3-day window', async () => {
      // Seed 1 attendance record within the lookback window for 2026-04-22
      await attendanceModel.create({
        workspaceId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(memberId),
        date: new Date('2026-04-21T00:00:00Z'), // Tuesday — inside the 3-day window
        status: 'present',
      });

      const shift = {
        startTime: '09:00',
        endTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      };

      const result = await detection.checkMissedStreak(
        wsId,
        memberId,
        shift,
        new Date('2026-04-22T00:00:00Z'),
      );

      // Attendance record exists → streak check returns null → no anomaly created
      expect(result).toBeNull();
    });

    it('missed_streak: repeated cron invocation (still unacknowledged) does NOT create a second record', async () => {
      const shift = {
        startTime: '09:00',
        endTime: '18:00',
        workingDays: [1, 2, 3, 4, 5],
      };

      // No attendance rows seeded — streak fires
      const result = await detection.checkMissedStreak(
        wsId,
        memberId,
        shift,
        new Date('2026-04-22T00:00:00Z'),
      );

      expect(result).not.toBeNull();

      const contextKey = `${memberId}:streak:${result.missingDays[result.missingDays.length - 1].slice(0, 10)}`;

      // Cron run 1
      await anomalies.record({
        wsId,
        ruleType: 'missed_streak',
        severity: 'medium',
        teamMemberId: memberId,
        deviceSerial: null,
        context: { streakLength: result.streakLength, missingDays: result.missingDays },
        contextKey,
      });

      // Cron run 2 — simulating the same job running the next day with the SAME unacknowledged record
      await anomalies.record({
        wsId,
        ruleType: 'missed_streak',
        severity: 'medium',
        teamMemberId: memberId,
        deviceSerial: null,
        context: { streakLength: result.streakLength + 1 }, // streakLength might differ day to day
        contextKey,
      });

      // Cron run 3 — yet another invocation
      await anomalies.record({
        wsId,
        ruleType: 'missed_streak',
        severity: 'medium',
        teamMemberId: memberId,
        deviceSerial: null,
        context: { streakLength: result.streakLength + 2 },
        contextKey,
      });

      const total = await anomalyModel.countDocuments({
        wsId: new Types.ObjectId(wsId),
        ruleType: 'missed_streak',
        acknowledged: false,
      });

      // Dedupe gate prevents alert fatigue — only 1 unacknowledged record regardless of cron frequency
      expect(total).toBe(1);
    });
  });
});
