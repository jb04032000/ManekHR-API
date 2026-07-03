import { describe, it, expect } from 'vitest';
import {
  computeProjectionForPhaseA,
  computeDailySummary,
  DEFAULT_SHIFT_SNAPSHOT,
  DEFAULT_POLICY_SNAPSHOT,
  type EventInput,
  type AttendanceEventSource,
} from './compute';

// ── Factories ────────────────────────────────────────────────────────────────
const statusSet = (
  source: AttendanceEventSource,
  statusValue: string,
  isoTime = '2026-04-20T10:00:00Z',
): EventInput => ({
  timestamp: new Date(isoTime),
  punchType: 'STATUS_SET',
  statusValue,
  source,
});

const checkIn = (
  source: AttendanceEventSource,
  isoTime = '2026-04-20T09:00:00Z',
): EventInput => ({
  timestamp: new Date(isoTime),
  punchType: 'CHECK_IN',
  statusValue: null,
  source,
});

const checkOut = (
  source: AttendanceEventSource,
  isoTime = '2026-04-20T18:00:00Z',
): EventInput => ({
  timestamp: new Date(isoTime),
  punchType: 'CHECK_OUT',
  statusValue: null,
  source,
});

const DAY = new Date('2026-04-20T00:00:00Z');

// Full list to drive pairwise tests
const NON_OVERRIDE_SOURCES: AttendanceEventSource[] = [
  'regularization',
  'device_push',
  'connector',
  'file_upload',
  'auto_cron',
  'manual',
];

// ── D-14: manual_override beats all — via STATUS_SET path ────────────────────
describe('source priority — D-14 pairwise manual_override wins (STATUS_SET)', () => {
  for (const loser of NON_OVERRIDE_SOURCES) {
    it(`manual_override beats ${loser} even when ${loser} is later`, () => {
      const result = computeProjectionForPhaseA([
        statusSet('manual_override', 'absent', '2026-04-20T09:00:00Z'),
        statusSet(loser, 'present', '2026-04-20T18:00:00Z'),
      ]);
      expect(result).not.toBeNull();
      expect(result!.dominantSource).toBe('manual_override');
      expect(result!.status).toBe('absent');
    });
  }
});

// ── D-14: manual_override beats all — via computeDailySummary CHECK_IN path ──
describe('source priority — D-14 pairwise via computeDailySummary (CHECK_IN path)', () => {
  for (const loser of NON_OVERRIDE_SOURCES) {
    it(`manual_override beats ${loser} in dominantSource resolution from punches`, () => {
      const summary = computeDailySummary(
        [
          checkIn(loser, '2026-04-20T09:00:00Z'),
          checkIn('manual_override', '2026-04-20T09:30:00Z'),
          checkOut('manual_override', '2026-04-20T18:00:00Z'),
        ],
        DEFAULT_SHIFT_SNAPSHOT,
        DEFAULT_POLICY_SNAPSHOT,
        DAY,
      );
      expect(summary.dominantSource).toBe('manual_override');
    });
  }
});

// ── D-15: Timestamp tie-break ────────────────────────────────────────────────
describe('source priority — D-15 timestamp tie-break', () => {
  it('two manual STATUS_SET events — later timestamp wins (status reflects later event)', () => {
    // Earlier: manual sets 'absent' at T+0; later: manual sets 'present' at T+1h
    const result = computeProjectionForPhaseA([
      statusSet('manual', 'absent', '2026-04-20T09:00:00Z'),
      statusSet('manual', 'present', '2026-04-20T10:00:00Z'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('present');
    expect(result!.dominantSource).toBe('manual');
  });

  it('two device_push CHECK_IN events — dominantSource is device_push (both same source)', () => {
    const summary = computeDailySummary(
      [
        checkIn('device_push', '2026-04-20T09:00:00Z'),
        checkIn('device_push', '2026-04-20T09:15:00Z'),
        checkOut('device_push', '2026-04-20T18:00:00Z'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    // Both events are device_push — dominantSource is device_push regardless of timestamps
    expect(summary.dominantSource).toBe('device_push');
  });

  it('earlier high-priority source beats later low-priority source (priority > timestamp)', () => {
    // regularization at T-1h (earlier) vs device_push at T (later)
    // priority: regularization(6) > device_push(5) → regularization wins despite earlier timestamp
    const summary = computeDailySummary(
      [
        checkIn('regularization', '2026-04-20T08:00:00Z'),
        checkIn('device_push', '2026-04-20T09:00:00Z'),
        checkOut('device_push', '2026-04-20T18:00:00Z'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(summary.dominantSource).toBe('regularization');
  });
});

// ── D-16: Full non-override priority chain ────────────────────────────────────
describe('source priority — D-16 full non-override chain', () => {
  const chain: [AttendanceEventSource, AttendanceEventSource][] = [
    ['regularization', 'device_push'],
    ['device_push', 'connector'],
    ['connector', 'file_upload'],
    ['file_upload', 'auto_cron'],
    ['auto_cron', 'manual'],
  ];
  for (const [winner, loser] of chain) {
    it(`${winner} beats ${loser}`, () => {
      const summary = computeDailySummary(
        [
          checkIn(loser, '2026-04-20T09:00:00Z'),
          checkIn(winner, '2026-04-20T09:00:01Z'),
          checkOut(winner, '2026-04-20T18:00:00Z'),
        ],
        DEFAULT_SHIFT_SNAPSHOT,
        DEFAULT_POLICY_SNAPSHOT,
        DAY,
      );
      expect(summary.dominantSource).toBe(winner);
    });
  }
});

// ── Edge cases ────────────────────────────────────────────────────────────────
describe('source priority — edge cases', () => {
  it('all 7 sources present as STATUS_SET — manual_override wins', () => {
    const allSources: AttendanceEventSource[] = [
      'manual',
      'auto_cron',
      'file_upload',
      'connector',
      'device_push',
      'regularization',
      'manual_override',
    ];
    const events: EventInput[] = allSources.map((src, i) =>
      statusSet(src, src === 'manual_override' ? 'absent' : 'present', `2026-04-20T${String(9 + i).padStart(2, '0')}:00:00Z`),
    );
    const result = computeProjectionForPhaseA(events);
    expect(result).not.toBeNull();
    expect(result!.dominantSource).toBe('manual_override');
  });

  it('empty event list to computeDailySummary → dominantSource defaults to manual', () => {
    const summary = computeDailySummary(
      [],
      { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'fixed' },
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    // dominantSource([]) returns 'manual' per compute.ts line 180
    expect(summary.dominantSource).toBe('manual');
    // absent because no check-in
    expect(summary.status).toBe('absent');
  });

  it('single auto_cron STATUS_SET event → dominantSource is auto_cron', () => {
    const result = computeProjectionForPhaseA([
      statusSet('auto_cron', 'present'),
    ]);
    expect(result).not.toBeNull();
    expect(result!.dominantSource).toBe('auto_cron');
    expect(result!.status).toBe('present');
  });
});
