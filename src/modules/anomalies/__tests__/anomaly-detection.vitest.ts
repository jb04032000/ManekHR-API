import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AnomalyDetectionService } from '../anomaly-detection.service';

interface ShiftSnapshot {
  startTime: string; // 'HH:mm'
  endTime: string; // 'HH:mm'
  workingDays: number[]; // 0=Sun..6=Sat
}

describe('AnomalyDetectionService', () => {
  let service: AnomalyDetectionService;

  beforeEach(() => {
    // Plan-04 constructor shape: (holidaysService, attendanceModel, anomaliesService?)
    // LRU cache max is hardcoded inside the class — no numeric arg passed.
    service = new AnomalyDetectionService(
      /* holidaysService */ { findByDate: vi.fn().mockResolvedValue(null) } as any,
      /* attendanceModel  */ {} as any,
    );
  });

  describe('detectTimeTravel', () => {
    it('returns true when |server - event| > 10 minutes (future skew)', () => {
      const eventTs = new Date('2026-04-19T09:00:00Z');
      const serverTs = new Date('2026-04-19T09:15:00Z'); // +15 min
      expect(service.detectTimeTravel(eventTs, serverTs)).toBe(true);
    });

    it('returns true when |server - event| > 10 minutes (past skew / device clock ahead)', () => {
      const eventTs = new Date('2026-04-19T09:15:00Z');
      const serverTs = new Date('2026-04-19T09:00:00Z'); // -15 min
      expect(service.detectTimeTravel(eventTs, serverTs)).toBe(true);
    });

    it('returns false at exactly 10 minutes (boundary)', () => {
      const eventTs = new Date('2026-04-19T09:00:00Z');
      const serverTs = new Date('2026-04-19T09:10:00Z');
      expect(service.detectTimeTravel(eventTs, serverTs)).toBe(false);
    });

    it('returns false at 5 minutes', () => {
      const eventTs = new Date('2026-04-19T09:00:00Z');
      const serverTs = new Date('2026-04-19T09:05:00Z');
      expect(service.detectTimeTravel(eventTs, serverTs)).toBe(false);
    });
  });

  describe('detectRapidDup', () => {
    const wsId = '60a0000000000000000000a1';
    const memberId = '60b0000000000000000000b1';
    const deviceA = 'SN-AAA';
    const deviceB = 'SN-BBB';

    it('returns false on first call', () => {
      expect(
        service.detectRapidDup(wsId, memberId, deviceA, new Date('2026-04-19T09:00:00Z')),
      ).toBe(false);
    });

    it('returns true on the 5th call within 10s for same (member, device)', () => {
      const base = new Date('2026-04-19T09:00:00Z').getTime();
      const out: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        out.push(service.detectRapidDup(wsId, memberId, deviceA, new Date(base + i * 1000)));
      }
      // First four must be false, fifth must be true (>= 5 threshold per DI-01).
      expect(out).toEqual([false, false, false, false, true]);
    });

    it('returns false when 5 events span > 10 seconds (sliding window eviction)', () => {
      const base = new Date('2026-04-19T09:00:00Z').getTime();
      const stamps = [0, 3000, 6000, 9000, 12_000]; // last two fall outside a 10s window from the oldest
      const out = stamps.map((offset) =>
        service.detectRapidDup(wsId, memberId, deviceA, new Date(base + offset)),
      );
      // At the t=12s stamp the 10s window [t=2s, t=12s] holds t=3s, t=6s, t=9s,
      // t=12s → 4 events, still < 5, so no trigger.
      expect(out[out.length - 1]).toBe(false);
    });

    it('does NOT count events from different deviceSerials (Pitfall 2)', () => {
      const base = new Date('2026-04-19T09:00:00Z').getTime();
      // 3 events on deviceA + 2 events on deviceB → neither device sees 5 → no trigger.
      service.detectRapidDup(wsId, memberId, deviceA, new Date(base));
      service.detectRapidDup(wsId, memberId, deviceA, new Date(base + 1000));
      service.detectRapidDup(wsId, memberId, deviceA, new Date(base + 2000));
      service.detectRapidDup(wsId, memberId, deviceB, new Date(base + 3000));
      const triggered = service.detectRapidDup(wsId, memberId, deviceB, new Date(base + 4000));
      expect(triggered).toBe(false);
    });

    /**
     * rapid_dup one-shot dedup guard (Task 3 Step 5).
     *
     * Once the threshold (5 events in 10s) is crossed, the LRU entry is marked `fired=true`.
     * Events 6, 7, 8 in the same burst must return false — only one anomaly row is created
     * per burst, preventing alert spam.
     */
    it('fires exactly once (on event 5) and suppresses events 6-8 in the same burst', () => {
      const base = new Date('2026-04-19T10:00:00Z').getTime();
      const results: boolean[] = [];
      for (let i = 0; i < 8; i++) {
        results.push(service.detectRapidDup(wsId, memberId, deviceA, new Date(base + i * 500)));
      }
      // Event 5 (index 4) → true. Events 1-4 and 6-8 → false.
      expect(results).toEqual([false, false, false, false, true, false, false, false]);
    });
  });

  describe('detectOffShift', () => {
    const shift: ShiftSnapshot = {
      startTime: '09:00',
      endTime: '18:00',
      workingDays: [1, 2, 3, 4, 5],
    };

    it('returns false when shift is null (no shift assigned)', () => {
      const eventTs = new Date('2026-04-19T02:00:00Z'); // any time
      expect(service.detectOffShift(eventTs, null)).toBe(false);
    });

    it('returns false when event is within shift bounds', () => {
      const eventTs = buildUtcTime('2026-04-20', '13:00'); // mid-shift
      expect(service.detectOffShift(eventTs, shift)).toBe(false);
    });

    it('returns true when event is 45 minutes before shiftStart', () => {
      const eventTs = buildUtcTime('2026-04-20', '08:15'); // shift 09:00, delta 45 > 30
      expect(service.detectOffShift(eventTs, shift)).toBe(true);
    });

    it('returns true when event is 45 minutes after shiftEnd', () => {
      const eventTs = buildUtcTime('2026-04-20', '18:45'); // shift 18:00, delta 45 > 30
      expect(service.detectOffShift(eventTs, shift)).toBe(true);
    });

    it('returns false at exactly 30 minutes after shiftEnd (boundary — not strictly >)', () => {
      const eventTs = buildUtcTime('2026-04-20', '18:30');
      expect(service.detectOffShift(eventTs, shift)).toBe(false);
    });

    /**
     * Timezone-basis regression guard (Task 3 Step 2).
     *
     * Shift startTime/endTime are stored as UTC-based HH:mm strings (parseShiftTime in
     * compute.ts uses setUTCHours, not setHours). Event timestamps are UTC Date objects.
     * Both coordinate systems are UTC — no workspace-timezone conversion is applied.
     *
     * This test constructs a punch at 09:30 UTC (well within the 09:00–18:00 UTC shift)
     * and asserts it is NOT flagged as off-shift. If detectOffShift incorrectly applied
     * a workspace-local offset (e.g. UTC+5:30 for IST) the UTC-basis code would compute
     * eventMin ≈ 04:00 UTC → 240 < 510 (09:00 − 30 = 480 min lower bound) → wrongly fire.
     * The current getUTCHours()-based implementation correctly returns false.
     */
    it('UTC-basis regression: punch at 09:30 UTC within a 09:00–18:00 UTC shift is NOT off-shift', () => {
      const punchAt0930UTC = new Date('2026-04-20T09:30:00Z');
      expect(service.detectOffShift(punchAt0930UTC, shift)).toBe(false);
    });
  });

  describe('getMissedStreakCandidates (pure helper)', () => {
    it('flags a member with zero punches on 3 consecutive working days', async () => {
      // Stub: attendanceModel returns zero matching records
      const attendanceModel = { countDocuments: vi.fn().mockResolvedValue(0) };
      const holidays = { findByDate: vi.fn().mockResolvedValue(null) };
      const svc = new AnomalyDetectionService(holidays as any, attendanceModel as any);
      const today = new Date('2026-04-22T00:00:00Z'); // Wednesday
      const candidate = await svc.checkMissedStreak(
        '60a0000000000000000000a1',
        '60b0000000000000000000b1',
        { startTime: '09:00', endTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
        today,
      );
      expect(candidate).not.toBeNull();
      expect(candidate?.streakLength).toBeGreaterThanOrEqual(3);
    });

    it('excludes weekly-off days (skips Sunday when workingDays does not include 0)', async () => {
      const attendanceModel = { countDocuments: vi.fn().mockResolvedValue(0) };
      const holidays = { findByDate: vi.fn().mockResolvedValue(null) };
      const svc = new AnomalyDetectionService(holidays as any, attendanceModel as any);
      // Run on a Monday after a weekend — the two weekend days should NOT count toward the streak.
      const monday = new Date('2026-04-20T00:00:00Z');
      const result = await svc.checkMissedStreak(
        '60a0000000000000000000a1',
        '60b0000000000000000000b1',
        { startTime: '09:00', endTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
        monday,
      );
      // Exercise: the helper should have queried only working days — validate the missingDays array does not include Saturday or Sunday.
      if (result) {
        for (const day of result.missingDays) {
          const dow = new Date(day).getUTCDay();
          expect([1, 2, 3, 4, 5]).toContain(dow);
        }
      }
    });

    it('excludes workspace holidays', async () => {
      const attendanceModel = { countDocuments: vi.fn().mockResolvedValue(0) };
      const holidays = {
        findByDate: vi.fn().mockImplementation((_wsId: string, date: string) =>
          // Mark Tuesday 2026-04-21 as a public holiday
          Promise.resolve(date.startsWith('2026-04-21') ? { _id: 'holiday1' } : null),
        ),
      };
      const svc = new AnomalyDetectionService(holidays as any, attendanceModel as any);
      const wednesday = new Date('2026-04-22T00:00:00Z');
      const result = await svc.checkMissedStreak(
        '60a0000000000000000000a1',
        '60b0000000000000000000b1',
        { startTime: '09:00', endTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
        wednesday,
      );
      if (result) {
        expect(result.missingDays.some((d: string) => d.startsWith('2026-04-21'))).toBe(false);
      }
    });

    it('does not fire when member has punches in the window', async () => {
      const attendanceModel = { countDocuments: vi.fn().mockResolvedValue(3) }; // 3 present days
      const holidays = { findByDate: vi.fn().mockResolvedValue(null) };
      const svc = new AnomalyDetectionService(holidays as any, attendanceModel as any);
      const today = new Date('2026-04-22T00:00:00Z');
      const result = await svc.checkMissedStreak(
        '60a0000000000000000000a1',
        '60b0000000000000000000b1',
        { startTime: '09:00', endTime: '18:00', workingDays: [1, 2, 3, 4, 5] },
        today,
      );
      expect(result).toBeNull();
    });
  });
});

// Helper — builds a Date at the given HH:mm in UTC. Shift times (shift.startTime)
// are themselves UTC-based, so the detector compares like-for-like.
function buildUtcTime(yyyy_mm_dd: string, hhmm: string): Date {
  return new Date(`${yyyy_mm_dd}T${hhmm}:00Z`);
}
