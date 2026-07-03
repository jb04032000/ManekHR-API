import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import LRU from 'lru-cache';
import { parseAttlog } from './utils/attlog-parser';
import { mapStatusCode, mapVerifyCode } from './utils/zk-code-mapper';
import {
  AttendanceDevice,
  AttendanceDeviceStatus,
} from '../attendance-devices/schemas/attendance-device.schema';
import { AttendanceDeviceCommand } from '../attendance-devices/schemas/attendance-device-command.schema';
import { AttendanceIngestLog } from './schemas/attendance-ingest-log.schema';
import { AttendanceEvent } from '../attendance/schemas/attendance-event.schema';
import {
  AttendanceProjectionService,
  RECOMPUTE_CONCURRENCY,
} from '../attendance/attendance-projection.service';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { Salary } from '../salary/schemas/salary.schema';

interface TokenCacheEntry {
  wsId: string;
  cachedAt: number; // epoch ms
}

interface RateLimitEntry {
  count: number;
  // resetAt omitted — LRU maxAge handles window expiry; window is fixed (anchored to
  // first push), not sliding. Do not add resetAt: it is dead code (WR-03).
}

const TOKEN_CACHE_TTL_MS = 60_000; // 60 seconds
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 1000; // max events per SN per minute

@Injectable()
export class AttendanceIngestService {
  private readonly logger = new Logger(AttendanceIngestService.name);
  /**
   * In-memory TTL cache: rawToken → wsId (60s TTL, per D-03).
   * Capped at 500 entries (LRU eviction) to prevent unbounded growth under
   * multi-tenant load or bot probing of the /iclock prefix (CR-01).
   */
  private readonly tokenCache = new LRU<string, TokenCacheEntry>({
    max: 500,
    maxAge: TOKEN_CACHE_TTL_MS,
  });
  /**
   * In-memory per-SN rate limit counter (per D-03, T-B-02-02).
   * Capped at 5 000 entries and TTL-evicted after the rate-limit window to
   * prevent indefinite accumulation for defunct devices (CR-01).
   */
  private readonly rateLimitMap = new LRU<string, RateLimitEntry>({
    max: 5000,
    maxAge: RATE_LIMIT_WINDOW_MS,
  });

  constructor(
    @InjectModel(AttendanceDevice.name)
    private readonly deviceModel: Model<AttendanceDevice>,
    @InjectModel(AttendanceDeviceCommand.name)
    private readonly commandModel: Model<AttendanceDeviceCommand>,
    @InjectModel(AttendanceIngestLog.name)
    private readonly ingestLogModel: Model<AttendanceIngestLog>,
    @InjectModel(AttendanceEvent.name)
    private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<any>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    private readonly projectionService: AttendanceProjectionService,
    private readonly anomaliesService: AnomaliesService,
  ) {}

  /**
   * Resolve a raw workspace token to a wsId string.
   * Uses in-memory TTL cache (60s) to avoid Mongo hit per device push.
   *
   * Security note: timingSafeEqual was removed (CR-02). The Mongo query itself is
   * not constant-time and already leaks a timing oracle (miss = fast, hit = slow).
   * The meaningful protection here is the IP-level rate limit on the /iclock prefix
   * and the LRU cap on the token cache that limits bot probing throughput.
   * The token is NOT logged — only an SHA-256 fingerprint on miss.
   */
  async resolveToken(rawToken: string): Promise<string | null> {
    const now = Date.now();
    // Cache hit — LRU automatically evicts entries older than TOKEN_CACHE_TTL_MS
    const cached = this.tokenCache.get(rawToken);
    if (cached) {
      return cached.wsId;
    }

    // Fetch the workspace whose token matches (direct Mongo lookup by value).
    const workspace = await this.workspaceModel
      .findOne({ attendanceIngestToken: rawToken })
      .select('_id')
      .lean()
      .exec();

    if (!workspace) {
      // Log a short SHA-256 fingerprint instead of raw token chars (CR-02 / IN-01).
      const fingerprint = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex')
        .slice(0, 8);
      this.logger.warn(
        `[AttendanceIngest] Token lookup failed (fp=${fingerprint})`,
      );
      return null;
    }

    const wsId = String(workspace._id);
    this.tokenCache.set(rawToken, { wsId, cachedAt: now });
    return wsId;
  }

  /**
   * Evict a token from the in-memory cache (called after token rotation).
   * Exported so AttendanceDevicesModule can call this on rotate.
   */
  evictFromCache(rawToken: string): void {
    (this.tokenCache as any).del(rawToken);
  }

  /**
   * Handle GET /iclock/:wsToken/cdata (device handshake).
   * Updates lastSeenAt; auto-registers device if unknown SN as pending_approval.
   */
  async handleHandshake(wsId: string, serial: string): Promise<void> {
    const now = new Date();
    const wsObjectId = new Types.ObjectId(wsId);

    const device = await this.deviceModel
      .findOne({ wsId: wsObjectId, serial })
      .exec();

    if (!device) {
      // Auto-register as pending_approval (D-09)
      const newDevice = await this.deviceModel.create({
        wsId: wsObjectId,
        serial,
        status: 'pending_approval',
        vendor: 'unknown',
        firstSeenAt: now,
        lastSeenAt: now,
      });
      this.logger.log(
        `[AttendanceIngest] Auto-registered device SN=${serial} for ws=${wsId} as pending_approval`,
      );
      // Fire-and-forget notification (D-06) — must not block ingest hot path
      setImmediate(() => {
        void this.anomaliesService.record({ wsId, ruleType: 'unknown_sn', severity: 'high', deviceSerial: serial, context: { serial, deviceId: String(newDevice._id) }, contextKey: serial });
      });
      return;
    }

    await this.deviceModel.updateOne(
      { _id: device._id },
      { $set: { lastSeenAt: now } },
    );
  }

  /**
   * Get device status for a given (wsId, serial), or null if not found.
   */
  async getDeviceStatus(
    wsId: string,
    serial: string,
  ): Promise<AttendanceDeviceStatus | null> {
    const device = await this.deviceModel
      .findOne({ wsId: new Types.ObjectId(wsId), serial })
      .select('status')
      .lean()
      .exec();
    return device ? (device.status as AttendanceDeviceStatus) : null;
  }

  /**
   * Handle POST /iclock/:wsToken/cdata?table=ATTLOG
   * Parse → rate-limit → check device status → insertMany → async projections.
   * Returns the number of events actually inserted (0 for dupes, non-active devices, etc.).
   */
  async handleAttlog(
    wsId: string,
    serial: string,
    rawBody: string,
  ): Promise<number> {
    const wsObjectId = new Types.ObjectId(wsId);
    const now = new Date();

    const records = parseAttlog(rawBody);
    if (records.length === 0) return 0;

    // Per-SN rate limit (T-B-02-02, D-03). Respond OK but discard on exceed.
    const rlKey = `${wsId}:${serial}`;
    const rl = this.rateLimitMap.get(rlKey);

    // LRU auto-evicts entries after RATE_LIMIT_WINDOW_MS (maxAge), so a missing
    // entry means the window has expired and we start a fresh counter.
    // Window is fixed (anchored to first push), not sliding — by design (WR-03).
    if (rl) {
      if (rl.count + records.length >= RATE_LIMIT_MAX) {
        this.logger.warn(
          `[AttendanceIngest] Rate limit exceeded SN=${serial} ws=${wsId}, discarding ${records.length} events`,
        );
        return 0;
      }
      rl.count += records.length;
    } else {
      this.rateLimitMap.set(rlKey, { count: records.length });
    }

    // Resolve device
    let device = await this.deviceModel
      .findOne({ wsId: wsObjectId, serial })
      .exec();

    if (!device) {
      // Auto-register as pending_approval
      const newDevice = await this.deviceModel.create({
        wsId: wsObjectId,
        serial,
        status: 'pending_approval',
        vendor: 'unknown',
        firstSeenAt: now,
        lastSeenAt: now,
      });
      this.logger.log(
        `[AttendanceIngest] Auto-registered device SN=${serial} for ws=${wsId} as pending_approval`,
      );
      // Fire-and-forget notification (D-06) — must not block ingest hot path
      setImmediate(() => {
        void this.anomaliesService.record({ wsId, ruleType: 'unknown_sn', severity: 'high', deviceSerial: serial, context: { serial, deviceId: String(newDevice._id) }, contextKey: serial });
      });
      return 0;
    }

    // Update lastSeenAt
    await this.deviceModel.updateOne(
      { _id: device._id },
      { $set: { lastSeenAt: now } },
    );

    // Discard events for non-active devices (D-10)
    if (device.status !== 'active') {
      return 0;
    }

    // Build event documents with biometric binding resolution
    const eventDocs = await Promise.all(
      records.map(async (r) => {
        // GAP-1.3-B: filter isDeleted:false so archived/offboarded members never
        // receive new events through stale biometric bindings.
        // GAP-1.1-B: use find().limit(2) instead of findOne() to detect
        // multi-match ambiguity and record an anomaly instead of silently picking one.
        const candidates = await this.teamMemberModel
          .find({
            workspaceId: wsObjectId,
            isDeleted: false,
            biometricBindings: {
              $elemMatch: {
                deviceSerial: serial,
                deviceUserId: r.deviceUserId,
              },
            },
          })
          .select('_id')
          .limit(2)
          .lean()
          .exec();

        let resolvedMemberId: any = null;
        if (candidates.length === 1) {
          resolvedMemberId = candidates[0]._id;
        } else if (candidates.length >= 2) {
          // GAP-1.1-B: ambiguous binding — record anomaly, do NOT guess. Admin must resolve.
          const candidateIds = candidates.map((c) => String(c._id));
          setImmediate(() => {
            void this.anomaliesService.record({
              wsId,
              ruleType: 'binding_conflict',
              severity: 'high',
              deviceSerial: serial,
              context: { serial, deviceUserId: r.deviceUserId, candidateMemberIds: candidateIds },
              contextKey: `${serial}:${r.deviceUserId}`,
            });
          });
          this.logger.warn(
            `[AttendanceIngest] Ambiguous binding SN=${serial} userId=${r.deviceUserId} matched ${candidates.length}+ members ws=${wsId} — event left unassigned`,
          );
        }

        return {
          wsId: wsObjectId,
          teamMemberId: resolvedMemberId,
          deviceSerial: serial,
          deviceUserId: r.deviceUserId,
          timestamp: r.timestamp,
          punchType: mapStatusCode(r.statusCode),
          verifyMethod: mapVerifyCode(r.verifyCode),
          source: 'device_push',
          sourceMeta: { sn: serial } as Record<string, unknown>,
        };
      }),
    );

    // GAP-2.3-A: reject events whose (member, month/year) hits a locked salary.
    // Unassigned events (teamMemberId === null) bypass this gate — they can't
    // be matched to a salary row until assigned via unassigned-punches UI.
    //
    // WR-04: collect unique (memberId, year, month) keys first, then fetch all
    // locked-salary checks in parallel with Promise.all instead of sequentially.
    // This reduces N×RTT (one per unique member-month) down to 1×RTT.
    const lockedMonthCache = new Map<string, boolean>(); // key: `${memberId}:${year}:${month}`

    // Step 1: collect unique keys (skip unassigned events).
    const uniqueKeys = new Set<string>();
    for (const doc of eventDocs) {
      if (!doc.teamMemberId) continue;
      const ts: Date = doc.timestamp as Date;
      const key = `${String(doc.teamMemberId)}:${ts.getUTCFullYear()}:${ts.getUTCMonth() + 1}`;
      uniqueKeys.add(key);
    }

    // Step 2: parallel DB fetch for all unique (memberId, year, month) combos.
    await Promise.all(
      Array.from(uniqueKeys).map(async (key) => {
        const [memberIdStr, yearStr, monthStr] = key.split(':');
        const salary = await this.salaryModel
          .findOne({
            workspaceId: wsObjectId,
            teamMemberId: new Types.ObjectId(memberIdStr),
            month: Number(monthStr),
            year: Number(yearStr),
          })
          .select('isLocked')
          .lean()
          .exec();
        lockedMonthCache.set(key, !!salary?.isLocked);
      }),
    );

    // Step 3: partition synchronously using the now-populated cache.
    const allowedEventDocs: typeof eventDocs = [];
    const lockedEventDocs: typeof eventDocs = [];
    for (const doc of eventDocs) {
      if (!doc.teamMemberId) { allowedEventDocs.push(doc); continue; }
      const ts: Date = doc.timestamp as Date;
      const key = `${String(doc.teamMemberId)}:${ts.getUTCFullYear()}:${ts.getUTCMonth() + 1}`;
      if (lockedMonthCache.get(key)) {
        lockedEventDocs.push(doc);
      } else {
        allowedEventDocs.push(doc);
      }
    }

    // Fire anomalies for each unique (memberId, month) hitting a locked payroll.
    // Dedup is via contextKey so a flood from the same device does not explode
    // the anomaly collection.
    const notifiedLockedKeys = new Set<string>();
    for (const doc of lockedEventDocs) {
      const ts: Date = doc.timestamp as Date;
      const month = ts.getUTCMonth() + 1;
      const year = ts.getUTCFullYear();
      const memberIdStr = String(doc.teamMemberId);
      const key = `${memberIdStr}:${year}-${String(month).padStart(2, '0')}`;
      if (notifiedLockedKeys.has(key)) continue;
      notifiedLockedKeys.add(key);
      setImmediate(() => {
        void this.anomaliesService.record({
          wsId,
          ruleType: 'locked_payroll_push',
          severity: 'medium',
          deviceSerial: serial,
          context: { serial, memberId: memberIdStr, month, year },
          contextKey: key,
        });
      });
    }
    if (lockedEventDocs.length > 0) {
      this.logger.warn(
        `[AttendanceIngest] ${lockedEventDocs.length} event(s) rejected for locked-payroll months on SN=${serial} ws=${wsId}`,
      );
    }

    // Batch insert — ordered:false so dup-key errors are per-record (D-16, T-B-02-07)
    let insertedCount = 0;
    try {
      const result = await (this.eventModel as any).insertMany(allowedEventDocs, {
        ordered: false,
      });
      insertedCount = Array.isArray(result) ? result.length : 0;
    } catch (err: any) {
      // BulkWriteError (E11000 duplicate key) — swallow, extract inserted count
      if (
        err?.name === 'MongoBulkWriteError' ||
        err?.code === 11000 ||
        err?.writeErrors
      ) {
        insertedCount =
          err?.result?.nInserted ??
          err?.insertedCount ??
          (err?.result?.result?.nInserted as number | undefined) ??
          0;
      } else {
        throw err;
      }
    }

    // Update device event stats
    if (insertedCount > 0) {
      await this.deviceModel.updateOne(
        { _id: device._id },
        {
          $inc: { 'stats.totalEvents': insertedCount },
          $set: { 'stats.lastEventAt': now },
        },
      );
    }

    // Fire-and-forget projections AFTER responding to device (Pitfall 5)
    if (insertedCount > 0) {
      setImmediate(() => {
        void this._recomputeProjections(wsId, allowedEventDocs);
      });
    }

    return insertedCount;
  }

  /**
   * Handle GET /iclock/:wsToken/getrequest
   * Dequeues the top queued command for this serial and returns its text,
   * or 'OK' if no command is queued.
   */
  async handleGetRequest(wsId: string, serial: string): Promise<string> {
    const command = await this.commandModel
      .findOneAndUpdate(
        { wsId: new Types.ObjectId(wsId), serial, status: 'queued' },
        { $set: { status: 'sent', sentAt: new Date() } },
        { sort: { createdAt: 1 }, new: true },
      )
      .exec();

    return command ? command.commandText : 'OK';
  }

  /**
   * Write an audit log record for an ingest request.
   * Non-critical — errors are swallowed.
   */
  async writeIngestLog(params: {
    wsId: string | null;
    deviceSerial: string | null;
    method: string;
    table: string | null;
    bodyBytes: number;
    responseStatus: number;
    error?: string | null;
  }): Promise<void> {
    try {
      await this.ingestLogModel.create({
        wsId: params.wsId ? new Types.ObjectId(params.wsId) : null,
        deviceSerial: params.deviceSerial,
        method: params.method,
        table: params.table,
        bodyBytes: params.bodyBytes,
        responseStatus: params.responseStatus,
        error: params.error ?? null,
      });
    } catch {
      // Non-critical audit log — do not propagate
    }
  }

  /** Recompute daily projections for all (member, date) pairs in a batch. */
  private async _recomputeProjections(
    wsId: string,
    eventDocs: Array<{ teamMemberId: any; timestamp: Date }>,
  ): Promise<void> {
    // Step 1: dedup (member, day) pairs synchronously (same logic as before).
    const seen = new Set<string>();
    const pairs: Array<{ memberId: string; day: Date }> = [];
    for (const doc of eventDocs) {
      if (!doc.teamMemberId) continue;
      const memberId = String(doc.teamMemberId);
      const day = new Date(doc.timestamp);
      day.setUTCHours(0, 0, 0, 0);
      const key = `${memberId}:${day.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ memberId, day });
    }

    // Step 2: parallelise recompute with bounded concurrency (H6-CONTEXT D-02).
    // Same RECOMPUTE_CONCURRENCY as recomputeRange for consistency.
    const limit = pLimit(RECOMPUTE_CONCURRENCY);
    await Promise.all(
      pairs.map((p) =>
        limit(async () => {
          try {
            await this.projectionService.recompute(wsId, p.memberId, p.day);
          } catch (e: any) {
            this.logger.warn(
              `[AttendanceIngest] Recompute failed member=${p.memberId} date=${p.day.toISOString()}: ${e.message}`,
            );
          }
        }),
      ),
    );
  }
}
