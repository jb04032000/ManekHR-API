import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import LRU from 'lru-cache';
import { AnomaliesService } from './anomalies.service';
import { HolidaysService } from '../holidays/holidays.service';

export interface ShiftSnapshot {
  _id?: string | Types.ObjectId;
  /**
   * Shift start time in 'HH:mm' format.
   * IMPORTANT: stored and compared in UTC (same coordinate system as AttendanceEvent.timestamp).
   * parseShiftTime in compute.ts writes shift times via setUTCHours, and event timestamps
   * are always persisted as UTC Date objects — no workspace-timezone conversion is required.
   */
  startTime: string;
  /** Shift end time in 'HH:mm' (UTC). See startTime note above. */
  endTime: string;
  workingDays: number[]; // 0=Sun..6=Sat
}

/** Internal LRU entry for rapid-dup burst tracking. */
interface RapidDupEntry {
  times: number[];
  /** Set to true when the threshold was first crossed for this burst window.
   *  Prevents multiple anomaly rows for events 6, 7, 8 … in the same burst. */
  fired: boolean;
}

export interface DetectedOnEventInput {
  _id?: string | Types.ObjectId;
  wsId: string | Types.ObjectId;
  teamMemberId?: string | Types.ObjectId | null;
  deviceSerial?: string | null;
  timestamp: Date;
  punchType?: string;
}

export interface HolidaysChecker {
  /** Return truthy if the given date string (any parseable format) is a workspace holiday. */
  findByDate(wsId: string, dateIso: string): Promise<unknown>;
}

const RAPID_DUP_WINDOW_MS = 10_000;
const RAPID_DUP_THRESHOLD = 5;
const RAPID_DUP_CACHE_MAX = 10_000;
const OFF_SHIFT_BUFFER_MIN = 30;
const TIME_TRAVEL_THRESHOLD_MS = 10 * 60 * 1000;
const MISSED_STREAK_DAYS = 3;

@Injectable()
export class AnomalyDetectionService {
  private readonly logger = new Logger(AnomalyDetectionService.name);
  private readonly tracer = trace.getTracer('anomalies');

  private readonly rapidDupWindow: LRU<string, RapidDupEntry> = new LRU<string, RapidDupEntry>({
    max: RAPID_DUP_CACHE_MAX,
    maxAge: RAPID_DUP_WINDOW_MS,
  });

  constructor(
    private readonly holidaysService: HolidaysService,
    @InjectModel('Attendance') private readonly attendanceModel: Model<any>,
    @Optional() private readonly anomaliesService?: AnomaliesService,
  ) {}

  // --- Pure detection helpers -------------------------------------------------

  detectTimeTravel(eventTs: Date, serverTs: Date): boolean {
    return Math.abs(serverTs.getTime() - eventTs.getTime()) > TIME_TRAVEL_THRESHOLD_MS;
  }

  detectRapidDup(
    wsId: string | Types.ObjectId,
    memberId: string | Types.ObjectId,
    deviceSerial: string,
    timestamp: Date,
  ): boolean {
    const key = `${String(wsId)}:${String(memberId)}:${deviceSerial}`;
    const now = timestamp.getTime();
    const windowStart = now - RAPID_DUP_WINDOW_MS;
    const existing = this.rapidDupWindow.get(key) ?? { times: [], fired: false };
    const inWindow = existing.times.filter((t) => t >= windowStart);
    inWindow.push(now);

    // A window holding only the current event means the previous burst fully
    // aged out — treat this as a fresh burst and re-arm the once-per-burst
    // marker. Burst-reset is driven by window content, not by LRU eviction
    // timing, so it stays correct regardless of cache TTL behaviour.
    const fired = inWindow.length === 1 ? false : existing.fired;

    // Threshold first met in this burst (!fired) → fire once, set the marker.
    if (!fired && inWindow.length >= RAPID_DUP_THRESHOLD) {
      this.rapidDupWindow.set(key, { times: inWindow, fired: true });
      return true;
    }

    // Already fired for this burst, or threshold not yet reached → suppress.
    this.rapidDupWindow.set(key, { times: inWindow, fired });
    return false;
  }

  detectOffShift(eventTs: Date, shift: ShiftSnapshot | null): boolean {
    if (!shift) return false;
    const eventMin = eventTs.getUTCHours() * 60 + eventTs.getUTCMinutes();
    const startMin = parseHHmm(shift.startTime);
    const endMin = parseHHmm(shift.endTime);
    const lowerBound = startMin - OFF_SHIFT_BUFFER_MIN;
    const upperBound = endMin + OFF_SHIFT_BUFFER_MIN;
    return eventMin < lowerBound || eventMin > upperBound;
  }

  /**
   * Determine whether a member has a missed-streak anomaly ending at `referenceDate`.
   * Returns metadata when a streak of >= MISSED_STREAK_DAYS working days with zero
   * attendance records exists; otherwise null.
   *
   * Skips weekly-off days (shift.workingDays) and workspace holidays (via holidaysService).
   */
  async checkMissedStreak(
    wsId: string | Types.ObjectId,
    memberId: string | Types.ObjectId,
    shift: ShiftSnapshot,
    referenceDate: Date,
  ): Promise<{ streakLength: number; missingDays: string[] } | null> {
    const missingDays: string[] = [];
    const candidate = new Date(referenceDate);
    candidate.setUTCHours(0, 0, 0, 0);

    // Walk backwards collecting working, non-holiday days until we have MISSED_STREAK_DAYS.
    // Safety cap: don't look back more than 14 calendar days to avoid edge conditions.
    let lookback = 0;
    while (missingDays.length < MISSED_STREAK_DAYS && lookback < 14) {
      const day = new Date(candidate);
      day.setUTCDate(day.getUTCDate() - lookback);
      lookback++;
      const dow = day.getUTCDay();
      if (!shift.workingDays.includes(dow)) continue;

      const iso = day.toISOString().slice(0, 10); // yyyy-mm-dd
      const holiday = await this.holidaysService.findByDate(String(wsId), iso);
      if (holiday) continue;

      missingDays.push(day.toISOString());
    }

    if (missingDays.length < MISSED_STREAK_DAYS) return null;

    // Query attendance for only the specific working dates in missingDays.
    // Using $in (not a date range) so that attendance records on non-working days
    // that fall within the span of missing working days do not falsely suppress the streak.
    const missingDateObjects = missingDays.map((iso) => new Date(iso));

    const presentCount = await this.attendanceModel.countDocuments({
      workspaceId: new Types.ObjectId(String(wsId)),
      teamMemberId: new Types.ObjectId(String(memberId)),
      date: { $in: missingDateObjects },
    });

    if (presentCount > 0) return null;

    return { streakLength: missingDays.length, missingDays };
  }

  // --- Orchestrator called from AttendanceEventService hook -------------------

  /**
   * Synchronous detection for a newly-written AttendanceEvent.
   * This method MUST NOT throw. Caller wraps in setImmediate but we double-wrap
   * in try/catch as defense-in-depth (Pitfall 1).
   */
  async detectOnEvent(
    event: DetectedOnEventInput,
    serverReceiptTime: Date = new Date(),
    shiftSnapshot: ShiftSnapshot | null = null,
  ): Promise<void> {
    return this.tracer.startActiveSpan('anomalies.detectOnEvent', async (span) => {
      const wsId = String(event.wsId);
      span.setAttributes({ workspaceId: wsId });
      try {
        if (!this.anomaliesService) {
          span.setAttributes({ result: 'no_service' });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }
        const memberId = event.teamMemberId ? String(event.teamMemberId) : null;
        const deviceSerial = event.deviceSerial ?? null;

        // 1. time_travel — always applicable
        if (this.detectTimeTravel(event.timestamp, serverReceiptTime)) {
          const deltaMinutes = Math.round(
            Math.abs(serverReceiptTime.getTime() - event.timestamp.getTime()) / 60000,
          );
          await this.anomaliesService.record({
            wsId,
            ruleType: 'time_travel',
            severity: 'medium',
            teamMemberId: memberId,
            deviceSerial,
            context: {
              eventTimestamp: event.timestamp.toISOString(),
              serverTime: serverReceiptTime.toISOString(),
              deltaMinutes,
            },
            // D-11: scope to the punch event UTC date so repeated replays of old events
            // on the same day produce at most one unacknowledged anomaly.
            contextKey: `${memberId ?? 'nm'}:${deviceSerial ?? 'nd'}:${event.timestamp.toISOString().slice(0, 10)}`,
          });
        }

        // 2. rapid_dup — requires member + device
        if (memberId && deviceSerial) {
          if (this.detectRapidDup(wsId, memberId, deviceSerial, event.timestamp)) {
            await this.anomaliesService.record({
              wsId,
              ruleType: 'rapid_dup',
              severity: 'high',
              teamMemberId: memberId,
              deviceSerial,
              context: {
                eventCount: RAPID_DUP_THRESHOLD,
                windowSeconds: RAPID_DUP_WINDOW_MS / 1000,
                deviceSerial,
              },
              contextKey: `${memberId}:${deviceSerial}`,
            });
          }
        }

        // 3. off_shift_punch — requires shift snapshot
        if (shiftSnapshot && this.detectOffShift(event.timestamp, shiftSnapshot)) {
          const eventMin = event.timestamp.getUTCHours() * 60 + event.timestamp.getUTCMinutes();
          const startMin = parseHHmm(shiftSnapshot.startTime);
          const endMin = parseHHmm(shiftSnapshot.endTime);
          const deltaMinutes =
            eventMin < startMin ? startMin - eventMin : eventMin > endMin ? eventMin - endMin : 0;
          await this.anomaliesService.record({
            wsId,
            ruleType: 'off_shift_punch',
            severity: 'medium',
            teamMemberId: memberId,
            deviceSerial,
            context: {
              eventTimestamp: event.timestamp.toISOString(),
              shiftStart: shiftSnapshot.startTime,
              shiftEnd: shiftSnapshot.endTime,
              deltaMinutes,
            },
            contextKey: `${memberId ?? 'nm'}:${new Date(event.timestamp).toISOString().slice(0, 10)}`,
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err: any) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        this.logger.warn(`[AnomalyDetection] detectOnEvent failed: ${err?.message}`);
        Sentry.captureException(err, { tags: { module: 'anomalies', op: 'detectOnEvent' } });
      } finally {
        span.end();
      }
    });
  }
}

function parseHHmm(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => parseInt(s, 10));
  return (h || 0) * 60 + (m || 0);
}
