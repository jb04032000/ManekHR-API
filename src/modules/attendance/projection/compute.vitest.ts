import { describe, it, expect } from 'vitest';
import { computeProjectionForPhaseA, pairSessions, type EventInput } from './compute';

const ev = (partial: Partial<EventInput>): EventInput => ({
  timestamp: new Date('2026-04-18T10:00:00Z'),
  punchType: 'STATUS_SET',
  statusValue: 'present',
  source: 'manual',
  ...partial,
});

describe('computeProjectionForPhaseA', () => {
  it('manual_override wins over device_push even if device is later', () => {
    const result = computeProjectionForPhaseA([
      ev({
        source: 'device_push',
        statusValue: 'present',
        timestamp: new Date('2026-04-18T18:00:00Z'),
      }),
      ev({
        source: 'manual_override',
        statusValue: 'absent',
        timestamp: new Date('2026-04-18T09:00:00Z'),
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result.status).toBe('absent');
    expect(result.dominantSource).toBe('manual_override');
  });

  it('with no manual_override, uses most-recent STATUS_SET', () => {
    const result = computeProjectionForPhaseA([
      ev({
        source: 'auto_cron',
        statusValue: 'present',
        timestamp: new Date('2026-04-18T08:00:00Z'),
      }),
      ev({ source: 'manual', statusValue: 'late', timestamp: new Date('2026-04-18T11:00:00Z') }),
    ]);
    expect(result.status).toBe('late');
    expect(result.dominantSource).toBe('manual');
  });

  it('empty events → returns null (preserve existing row)', () => {
    expect(computeProjectionForPhaseA([])).toBeNull();
  });

  it('only CHECK_IN/CHECK_OUT events (no STATUS_SET) → returns null in Phase A', () => {
    const result = computeProjectionForPhaseA([
      ev({ punchType: 'CHECK_IN', statusValue: null, source: 'device_push' }),
      ev({ punchType: 'CHECK_OUT', statusValue: null, source: 'device_push' }),
    ]);
    expect(result).toBeNull();
  });

  it('multiple manual_override events → uses latest by timestamp', () => {
    const result = computeProjectionForPhaseA([
      ev({
        source: 'manual_override',
        statusValue: 'absent',
        timestamp: new Date('2026-04-18T09:00:00Z'),
      }),
      ev({
        source: 'manual_override',
        statusValue: 'half_day',
        timestamp: new Date('2026-04-18T14:00:00Z'),
      }),
    ]);
    expect(result.status).toBe('half_day');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase C: computeDailySummary tests
// ────────────────────────────────────────────────────────────────────────────
import {
  computeDailySummary,
  DEFAULT_SHIFT_SNAPSHOT,
  DEFAULT_POLICY_SNAPSHOT,
  type ShiftSnapshot,
  type PolicySnapshot,
} from './compute';

const DATE = new Date('2026-04-18T00:00:00Z'); // UTC midnight (a Friday)

// Fixed shift: 09:00–18:00 UTC, grace=10min, halfDay@60min
const FIXED_SHIFT: ShiftSnapshot = {
  startTime: '09:00',
  endTime: '18:00',
  gracePeriodMinutes: 10,
  halfDayAfterLateMinutes: 60,
  shiftType: 'fixed',
  requiredHoursPerDay: null,
};

// OT-enabled policy: threshold=30, cap=120
const OT_POLICY: PolicySnapshot = {
  lateArrival: { countAsLop: false, lopAfterNLateDays: null },
  earlyDeparture: { enabled: false, thresholdMinutes: 30, countAsHalfDay: false },
  ot: { enabled: true, thresholdMinutes: 30, capMinutes: 120 },
  compOff: { enabled: false },
};

// No-OT policy
const NO_OT_POLICY: PolicySnapshot = {
  lateArrival: { countAsLop: false, lopAfterNLateDays: null },
  earlyDeparture: { enabled: false, thresholdMinutes: 30, countAsHalfDay: false },
  ot: { enabled: false, thresholdMinutes: 30, capMinutes: null },
  compOff: { enabled: false },
};

// Helper: build EventInput with time offset from UTC midnight
const punch = (partial: Partial<EventInput> & { hhmm?: string }): EventInput => {
  const base: EventInput = {
    timestamp: new Date('2026-04-18T09:00:00Z'),
    punchType: 'CHECK_IN',
    statusValue: null,
    source: 'device_push',
  };
  if (partial.hhmm) {
    base.timestamp = new Date(`2026-04-18T${partial.hhmm}:00Z`);
  }
  return { ...base, ...partial };
};

describe('computeDailySummary — fixed shift', () => {
  it('on-time check-in → status=present, lateMinutes=0', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:05', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('present');
    expect(result.lateMinutes).toBe(0);
    // 09:05 is within the 10-min grace → worked time credited from 09:00.
    expect(result.workedMinutes).toBeCloseTo(540, 0);
  });

  it('grace=10, late by 12 min → status=late, lateMinutes=2', () => {
    // Check-in at 09:22 → 22 min past 09:00 → after grace(10) = 12 min late
    const result = computeDailySummary(
      [punch({ hhmm: '09:22', punchType: 'CHECK_IN' })],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('late');
    expect(result.lateMinutes).toBeCloseTo(12, 0);
    expect(result.workedMinutes).toBeNull(); // no checkout
  });

  it('late >= halfDayAfterLateMinutes → status=half_day', () => {
    // Check-in at 11:10 → 130 min past start → after grace(10) = 120 min late >= 60
    const result = computeDailySummary(
      [
        punch({ hhmm: '11:10', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('half_day');
    expect(result.lateMinutes).toBeGreaterThanOrEqual(60);
  });

  it('no check-in → status=absent, workedMinutes=null, lateMinutes=0', () => {
    const result = computeDailySummary([], FIXED_SHIFT, NO_OT_POLICY, DATE);
    expect(result.status).toBe('absent');
    expect(result.workedMinutes).toBeNull();
    expect(result.lateMinutes).toBe(0);
    expect(result.otMinutes).toBe(0);
  });

  it('check-in but no check-out → status resolved, workedMinutes=null', () => {
    const result = computeDailySummary(
      [punch({ hhmm: '09:05', punchType: 'CHECK_IN' })],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('present');
    expect(result.workedMinutes).toBeNull();
    expect(result.otMinutes).toBe(0);
  });

  it('STATUS_SET manual_override short-circuits all punch logic', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:05', punchType: 'CHECK_IN' }),
        ev({ punchType: 'STATUS_SET', statusValue: 'on_leave', source: 'manual_override' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('on_leave');
    expect(result.workedMinutes).toBeNull();
    expect(result.lateMinutes).toBe(0);
  });

  it('OT: checkOut 45min past shiftEnd, threshold=30 → otMinutes=15', () => {
    // shiftEnd=18:00, checkOut=18:45 → (45 - 30) = 15 min OT
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:05', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:45', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      OT_POLICY,
      DATE,
    );
    expect(result.otMinutes).toBeCloseTo(15, 0);
  });

  it('OT disabled → otMinutes=0 regardless of checkOut time', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:05', punchType: 'CHECK_IN' }),
        punch({ hhmm: '20:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.otMinutes).toBe(0);
  });

  it('OT capMinutes=120, would be 150 → capped at 120', () => {
    // checkOut=21:00, shiftEnd=18:00 → 180min past - 30min threshold = 150 → capped at 120
    const cappedPolicy: PolicySnapshot = {
      ...OT_POLICY,
      ot: { enabled: true, thresholdMinutes: 30, capMinutes: 120 },
    };
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '21:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      cappedPolicy,
      DATE,
    );
    expect(result.otMinutes).toBe(120);
  });

  it('computeReason is a non-empty string', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:05', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(typeof result.computeReason).toBe('string');
    expect(result.computeReason.length).toBeGreaterThan(5);
  });
});

describe('computeDailySummary — flexi shift', () => {
  const FLEXI: ShiftSnapshot = {
    startTime: '00:00',
    endTime: '23:59',
    gracePeriodMinutes: 0,
    halfDayAfterLateMinutes: 60,
    shiftType: 'flexi',
    requiredHoursPerDay: 8,
  };

  it('workedMinutes >= 8h → status=present', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '17:30', punchType: 'CHECK_OUT' }),
      ],
      FLEXI,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('present');
    expect(result.lateMinutes).toBe(0);
  });

  it('workedMinutes < 8h → status=half_day', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '13:00', punchType: 'CHECK_OUT' }),
      ],
      FLEXI,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('half_day');
  });

  it('no checkout → workedMinutes=null, status=half_day', () => {
    const result = computeDailySummary(
      [punch({ hhmm: '09:00', punchType: 'CHECK_IN' })],
      FLEXI,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.workedMinutes).toBeNull();
    expect(result.status).toBe('half_day');
  });
});

describe('computeDailySummary — split shift', () => {
  const SPLIT: ShiftSnapshot = { ...FIXED_SHIFT, shiftType: 'split' };

  it('two complete blocks → workedMinutes = sum of both durations', () => {
    // Block 1: 09:00–13:00 (240 min), Block 2: 14:00–18:00 (240 min) = 480 total
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '13:00', punchType: 'CHECK_OUT' }),
        punch({ hhmm: '14:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      SPLIT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.workedMinutes).toBeCloseTo(480, 0);
    expect(result.checkIn?.toISOString()).toContain('09:00');
  });

  it('second block missing checkout → workedMinutes=null', () => {
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '13:00', punchType: 'CHECK_OUT' }),
        punch({ hhmm: '14:00', punchType: 'CHECK_IN' }),
        // no second CHECK_OUT
      ],
      SPLIT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.workedMinutes).toBeNull();
  });
});

describe('computeDailySummary — break shift', () => {
  const BREAK_SHIFT: ShiftSnapshot = { ...FIXED_SHIFT, shiftType: 'break' };

  it('BREAK_OUT + BREAK_IN subtract from workedMinutes', () => {
    // Check-in 09:00, break-out 12:00, break-in 13:00 (60min break), check-out 18:00
    // Gross: 540min, break: 60min → net: 480min
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '12:00', punchType: 'BREAK_OUT' }),
        punch({ hhmm: '13:00', punchType: 'BREAK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      BREAK_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.workedMinutes).toBeCloseTo(480, 0);
  });

  it('unclosed break (BREAK_OUT no BREAK_IN) → break duration treated as 0', () => {
    // Unclosed break should not reduce workedMinutes (conservative)
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '12:00', punchType: 'BREAK_OUT' }),
        // no BREAK_IN
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      BREAK_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    // 540 min gross, 0 break subtracted
    expect(result.workedMinutes).toBeCloseTo(540, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H2-02 Task 1: Grace-period boundary, OT math, missing-checkout parity
// ────────────────────────────────────────────────────────────────────────────

// Factory helper for new describe blocks (uses ISO string, avoids name collision with existing `punch`)
const mkPunch = (
  isoTime: string,
  punchType: EventInput['punchType'],
  source: EventInput['source'] = 'device_push',
): EventInput => ({
  timestamp: new Date(isoTime),
  punchType,
  statusValue: null,
  source,
});
const DAY = new Date('2026-04-20T00:00:00Z');

describe('computeDailySummary — grace period boundary (D-11)', () => {
  // Test A: arrive exactly at shiftStart + gracePeriodMinutes → ON_TIME
  it('Test A: arrive exactly at grace boundary → status=present, lateMinutes=0', () => {
    const shift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, gracePeriodMinutes: 10 };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:10:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT')],
      shift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('present');
    expect(result.lateMinutes).toBe(0);
  });

  // Test B: arrive 1 minute past grace boundary → LATE, lateMinutes=1
  it('Test B: arrive 1 min past grace boundary → status=late, lateMinutes=1', () => {
    const shift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, gracePeriodMinutes: 10 };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:11:00Z', 'CHECK_IN')],
      shift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('late');
    expect(result.lateMinutes).toBe(1);
  });

  // Test C: arrive exactly at shiftStart with grace=0 → present
  it('Test C: arrive exactly at shiftStart with grace=0 → status=present', () => {
    const shift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, gracePeriodMinutes: 0 };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT')],
      shift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('present');
    expect(result.lateMinutes).toBe(0);
  });

  // Test D: arrive 1ms before shiftStart with grace=0 → present, lateMinutes=0 (not negative)
  it('Test D: arrive 1 ms early with grace=0 → status=present, lateMinutes=0', () => {
    const shift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, gracePeriodMinutes: 0 };
    const result = computeDailySummary(
      [
        {
          timestamp: new Date('2026-04-20T08:59:59.999Z'),
          punchType: 'CHECK_IN',
          statusValue: null,
          source: 'device_push',
        },
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
      ],
      shift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('present');
    expect(result.lateMinutes).toBe(0);
  });
});

describe('computeDailySummary — OT math (D-09 OT coverage)', () => {
  // Test E: OT enabled, threshold=30, cap=null, checkOut 45min past shiftEnd → otMinutes=15
  it('Test E: OT enabled no cap, checkOut 45min past shiftEnd → otMinutes=15', () => {
    const otPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      ot: { enabled: true, thresholdMinutes: 30, capMinutes: null },
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:45:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      otPolicy,
      DAY,
    );
    expect(result.otMinutes).toBe(15);
  });

  // Test F: OT enabled, threshold=30, cap=10, checkOut 45min past shiftEnd → otMinutes=10 (capped)
  it('Test F: OT enabled with cap=10, would be 15 → capped at 10', () => {
    const otPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      ot: { enabled: true, thresholdMinutes: 30, capMinutes: 10 },
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:45:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      otPolicy,
      DAY,
    );
    expect(result.otMinutes).toBe(10);
  });

  // Test G: OT disabled → otMinutes=0 regardless of checkOut time
  it('Test G: OT disabled → otMinutes=0 even with checkOut 2h past shiftEnd', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T20:00:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.otMinutes).toBe(0);
  });

  // Test H: checkOut exactly at shiftEnd + threshold → otMinutes=0 (boundary, no OT)
  it('Test H: checkOut exactly at threshold boundary → otMinutes=0', () => {
    const otPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      ot: { enabled: true, thresholdMinutes: 30, capMinutes: null },
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:30:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      otPolicy,
      DAY,
    );
    expect(result.otMinutes).toBe(0);
  });

  // Test I: no CHECK_OUT event → otMinutes=0 regardless of policy
  it('Test I: no CHECK_OUT → otMinutes=0 regardless of OT policy', () => {
    const otPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      ot: { enabled: true, thresholdMinutes: 0, capMinutes: null },
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN')],
      DEFAULT_SHIFT_SNAPSHOT,
      otPolicy,
      DAY,
    );
    expect(result.otMinutes).toBe(0);
  });
});

describe('computeDailySummary — missing check-out parity (D-10)', () => {
  // Test J: fixed shift, CHECK_IN only → workedMinutes=null
  it('Test J: fixed shift CHECK_IN only → workedMinutes=null, computeReason contains "No checkout"', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:05:00Z', 'CHECK_IN')],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.workedMinutes).toBeNull();
    expect(result.computeReason).toMatch(/[Nn]o checkout/);
  });

  // Test K: flexi shift, CHECK_IN only → workedMinutes=null, status=half_day
  it('Test K: flexi shift CHECK_IN only → workedMinutes=null, status=half_day', () => {
    const flexiShift: ShiftSnapshot = {
      ...DEFAULT_SHIFT_SNAPSHOT,
      startTime: '00:00',
      endTime: '23:59',
      gracePeriodMinutes: 0,
      shiftType: 'flexi',
      requiredHoursPerDay: 8,
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN')],
      flexiShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.workedMinutes).toBeNull();
    expect(result.status).toBe('half_day');
    expect(result.computeReason).toMatch(/[Nn]o checkout/);
  });

  // Test L: split shift, two CHECK_INs with only first CHECK_OUT → workedMinutes=null
  it('Test L: split shift with unclosed second block → workedMinutes=null', () => {
    const splitShift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'split' };
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T12:00:00Z', 'CHECK_OUT'),
        mkPunch('2026-04-20T13:00:00Z', 'CHECK_IN'),
        // no second CHECK_OUT
      ],
      splitShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.workedMinutes).toBeNull();
  });

  // Test M: break shift, CHECK_IN only → workedMinutes=null
  it('Test M: break shift CHECK_IN only → workedMinutes=null, computeReason contains "No checkout"', () => {
    const breakShift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'break' };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN')],
      breakShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.workedMinutes).toBeNull();
    expect(result.computeReason).toMatch(/[Nn]o checkout/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H2-02 Task 2: Midnight-crossing, shift-type matrix, LOP accumulation, shape invariants
// ────────────────────────────────────────────────────────────────────────────

describe('computeDailySummary — midnight-crossing shift (D-12)', () => {
  const overnightShift: ShiftSnapshot = {
    ...DEFAULT_SHIFT_SNAPSHOT,
    startTime: '22:00',
    endTime: '06:00',
    gracePeriodMinutes: 0,
    shiftType: 'fixed',
  };
  const DAY_N = new Date('2026-04-20T00:00:00Z');

  // Test N: check-in at 22:00, check-out at 06:00 next day → status=present, workedMinutes=480
  it('Test N: overnight shift full attendance → status=present, workedMinutes=480, lateMinutes=0', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T22:00:00Z', 'CHECK_IN'), mkPunch('2026-04-21T06:00:00Z', 'CHECK_OUT')],
      overnightShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY_N,
    );
    expect(result.status).toBe('present');
    expect(result.workedMinutes).toBeCloseTo(480, 0);
    expect(result.lateMinutes).toBe(0);
  });

  // Test O: check-in at 22:15 (15 min late, grace=0) → status=late, lateMinutes=15
  it('Test O: overnight shift, check-in 15 min late → status=late, lateMinutes=15', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T22:15:00Z', 'CHECK_IN'), mkPunch('2026-04-21T06:15:00Z', 'CHECK_OUT')],
      overnightShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY_N,
    );
    expect(result.status).toBe('late');
    expect(result.lateMinutes).toBe(15);
  });

  // Test P: check-out at 07:00 next day (1h past shift end), OT enabled threshold=0, cap=null → otMinutes=60
  it('Test P: overnight shift, checkout 1h past shiftEnd, OT threshold=0 → otMinutes=60', () => {
    const otPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      ot: { enabled: true, thresholdMinutes: 0, capMinutes: null },
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T22:00:00Z', 'CHECK_IN'), mkPunch('2026-04-21T07:00:00Z', 'CHECK_OUT')],
      overnightShift,
      otPolicy,
      DAY_N,
    );
    expect(result.otMinutes).toBe(60);
  });
});

describe('computeDailySummary — shift-type matrix (D-09)', () => {
  // Test Q: fixed shift happy path → status=present, exact workedMinutes
  it('Test Q: fixed shift happy path → status=present, workedMinutes=540', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT')],
      { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'fixed' },
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('present');
    expect(result.workedMinutes).toBeCloseTo(540, 0);
  });

  // Test R: flexi shift, requiredHoursPerDay=6, worked 7h → status=present, workedMinutes=420
  it('Test R: flexi requiredHoursPerDay=6, worked 7h → status=present, workedMinutes=420', () => {
    const flexiShift: ShiftSnapshot = {
      ...DEFAULT_SHIFT_SNAPSHOT,
      shiftType: 'flexi',
      requiredHoursPerDay: 6,
      startTime: '00:00',
      endTime: '23:59',
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T16:00:00Z', 'CHECK_OUT')],
      flexiShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('present');
    expect(result.workedMinutes).toBeCloseTo(420, 0);
  });

  // Test S: flexi requiredHoursPerDay=null (defaults 8h), worked 6h → status=half_day, workedMinutes=360
  it('Test S: flexi requiredHoursPerDay=null (defaults 8h), worked 6h → status=half_day, workedMinutes=360', () => {
    const flexiShift: ShiftSnapshot = {
      ...DEFAULT_SHIFT_SNAPSHOT,
      shiftType: 'flexi',
      requiredHoursPerDay: null,
      startTime: '00:00',
      endTime: '23:59',
    };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T15:00:00Z', 'CHECK_OUT')],
      flexiShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('half_day');
    expect(result.workedMinutes).toBeCloseTo(360, 0);
  });

  // Test T: split shift, 2 blocks (09:00-12:00, 13:00-18:00) → status=present, workedMinutes=480, computeReason contains "2 block"
  it('Test T: split shift 2 blocks → status=present, workedMinutes=480, computeReason contains "2 block"', () => {
    const splitShift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'split' };
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T12:00:00Z', 'CHECK_OUT'),
        mkPunch('2026-04-20T13:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
      ],
      splitShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.status).toBe('present');
    expect(result.workedMinutes).toBeCloseTo(480, 0); // 180 + 300
    expect(result.computeReason).toMatch(/2 block/);
  });

  // Test U: break shift, check-in 09:00, break_out 13:00, break_in 14:00, check-out 18:00 → workedMinutes=480 (540 - 60)
  it('Test U: break shift with 1h break → workedMinutes=480 (9h gross - 1h break)', () => {
    const breakShift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'break' };
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T13:00:00Z', 'BREAK_OUT'),
        mkPunch('2026-04-20T14:00:00Z', 'BREAK_IN'),
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
      ],
      breakShift,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.workedMinutes).toBeCloseTo(480, 0); // 540 - 60
  });
});

describe('computeDailySummary — LOP accumulation (D-13)', () => {
  // Test V: D-13 is out-of-scope for single-day pure function — documented here
  it.skip('Test V: lopAfterNLateDays threshold accumulation (D-13 — projection-service scope, not single-day)', () => {
    // D-13: lopAfterNLateDays threshold is a month-level / projection-service concern.
    // computeDailySummary is a single-day pure function — the lateArrival.countAsLop and
    // lopAfterNLateDays fields on PolicySnapshot are READ by this function (see DailySummary shape)
    // but the threshold aggregation happens in AttendanceProjectionService.recomputeMonth().
    // Single-day LOP math is not in scope for this unit test file.
    // See H2-02-SUMMARY.md for rationale and H4 integration test coverage path.
  });

  // Test W: single-day DailySummary does NOT include lopMinutes/lopDays — only the 8 documented keys
  it('Test W: DailySummary with countAsLop=true + late check-in has no lopMinutes or lopDays field', () => {
    const lopPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      lateArrival: { countAsLop: true, lopAfterNLateDays: 3 },
    };
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:30:00Z', 'CHECK_IN'), // 30 min late with grace=0
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      lopPolicy,
      DAY,
    );
    expect((result as Record<string, unknown>)['lopMinutes']).toBeUndefined();
    expect((result as Record<string, unknown>)['lopDays']).toBeUndefined();
    // The function still correctly marks as late
    expect(result.status).toBe('late');
    expect(result.lateMinutes).toBe(30);
  });
});

describe('computeDailySummary — shape invariants', () => {
  // Test X: return object has exactly the 9 DailySummary keys
  it('Test X: result has exactly the 9 DailySummary keys', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    const expectedKeys = [
      'status',
      'checkIn',
      'checkOut',
      'workedMinutes',
      'lateMinutes',
      'earlyMinutes',
      'otMinutes',
      'computeReason',
      'dominantSource',
    ];
    expect(Object.keys(result).sort()).toEqual([...expectedKeys].sort());
  });

  // Test Y: lateMinutes is never negative (arrive 1h early, grace=0) → lateMinutes=0
  it('Test Y: lateMinutes never negative when arriving early with grace=0', () => {
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T08:00:00Z', 'CHECK_IN'), // 1h early
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.lateMinutes).toBe(0);
  });

  // Test Z: otMinutes is never negative (early departure, OT enabled) → otMinutes=0
  it('Test Z: otMinutes never negative when leaving before shiftEnd', () => {
    const otPolicy = {
      ...DEFAULT_POLICY_SNAPSHOT,
      ot: { enabled: true, thresholdMinutes: 30, capMinutes: null },
    };
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T15:00:00Z', 'CHECK_OUT'), // 3h early departure
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      otPolicy,
      DAY,
    );
    expect(result.otMinutes).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Attendance Completion P1: early-departure policy + 'self' event source
// ────────────────────────────────────────────────────────────────────────────

describe('computeDailySummary — early departure', () => {
  // DEFAULT_SHIFT_SNAPSHOT is fixed 09:00–18:00, grace 0.
  const ED_FLAG_ONLY: PolicySnapshot = {
    ...DEFAULT_POLICY_SNAPSHOT,
    earlyDeparture: { enabled: true, thresholdMinutes: 30, countAsHalfDay: false },
  };
  const ED_HALF_DAY: PolicySnapshot = {
    ...DEFAULT_POLICY_SNAPSHOT,
    earlyDeparture: { enabled: true, thresholdMinutes: 30, countAsHalfDay: true },
  };

  it('left 60 min early, threshold 30 → earlyMinutes=30, status stays present (flag only)', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T17:00:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      ED_FLAG_ONLY,
      DAY,
    );
    expect(result.earlyMinutes).toBe(30);
    expect(result.status).toBe('present');
  });

  it('left 60 min early with countAsHalfDay → status=half_day', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T17:00:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      ED_HALF_DAY,
      DAY,
    );
    expect(result.earlyMinutes).toBe(30);
    expect(result.status).toBe('half_day');
  });

  it('left within threshold (20 min early, threshold 30) → earlyMinutes=0, no downgrade', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T17:40:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      ED_HALF_DAY,
      DAY,
    );
    expect(result.earlyMinutes).toBe(0);
    expect(result.status).toBe('present');
  });

  it('earlyDeparture disabled → earlyMinutes=0 even leaving 3h early', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T15:00:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.earlyMinutes).toBe(0);
  });

  it('no checkout → earlyMinutes=0 regardless of policy', () => {
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN')],
      DEFAULT_SHIFT_SNAPSHOT,
      ED_HALF_DAY,
      DAY,
    );
    expect(result.earlyMinutes).toBe(0);
  });

  it('late check-in + early departure with countAsHalfDay → status downgraded to half_day', () => {
    // check-in 09:30 (30 min late, grace 0) → 'late'; checkout 17:00 (60 min early) → half_day
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:30:00Z', 'CHECK_IN'), mkPunch('2026-04-20T17:00:00Z', 'CHECK_OUT')],
      DEFAULT_SHIFT_SNAPSHOT,
      ED_HALF_DAY,
      DAY,
    );
    expect(result.status).toBe('half_day');
    expect(result.earlyMinutes).toBe(30);
  });

  it('split shift early departure → earlyMinutes from last-block checkout', () => {
    const splitShift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'split' };
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T12:00:00Z', 'CHECK_OUT'),
        mkPunch('2026-04-20T13:00:00Z', 'CHECK_IN'),
        mkPunch('2026-04-20T17:00:00Z', 'CHECK_OUT'),
      ],
      splitShift,
      ED_FLAG_ONLY,
      DAY,
    );
    expect(result.earlyMinutes).toBe(30);
  });

  it('break shift early departure → earlyMinutes set', () => {
    const breakShift: ShiftSnapshot = { ...DEFAULT_SHIFT_SNAPSHOT, shiftType: 'break' };
    const result = computeDailySummary(
      [mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'), mkPunch('2026-04-20T17:00:00Z', 'CHECK_OUT')],
      breakShift,
      ED_FLAG_ONLY,
      DAY,
    );
    expect(result.earlyMinutes).toBe(30);
  });
});

describe("computeDailySummary — 'self' event source", () => {
  it('self-source punches → dominantSource=self', () => {
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN', 'self'),
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT', 'self'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.dominantSource).toBe('self');
  });

  it('self outranks manual + auto_cron in dominantSource', () => {
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN', 'manual'),
        mkPunch('2026-04-20T09:01:00Z', 'CHECK_IN', 'auto_cron'),
        mkPunch('2026-04-20T09:02:00Z', 'CHECK_IN', 'self'),
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT', 'self'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.dominantSource).toBe('self');
  });

  it('device_push still outranks self', () => {
    const result = computeDailySummary(
      [
        mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN', 'self'),
        mkPunch('2026-04-20T09:01:00Z', 'CHECK_IN', 'device_push'),
        mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT', 'device_push'),
      ],
      DEFAULT_SHIFT_SNAPSHOT,
      DEFAULT_POLICY_SNAPSHOT,
      DAY,
    );
    expect(result.dominantSource).toBe('device_push');
  });
});

// H2-02 coverage summary: D-09 (4 shift types) ✓, D-10 (missing checkout × 4) ✓, D-11 (grace boundary) ✓, D-12 (midnight-crossing) ✓, D-13 (LOP accumulation) — documented out-of-scope for single-day fn; see tests V/W.
// P1 coverage: early-departure (flag / half-day / threshold / disabled / no-checkout / late+early / split / break) ✓, 'self' source priority ✓.
// Grace-credit coverage: within-grace worked-minute credit (fixed / split / break) ✓, beyond-grace not credited ✓, early punch not clamped ✓.

describe('computeDailySummary — grace-credited worked minutes', () => {
  it('fixed: within-grace late check-in credits worked time from shift start', () => {
    // 09:08 on an 09:00 shift, grace 10 → on-time AND worked from 09:00.
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:08', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('present');
    expect(result.lateMinutes).toBe(0);
    expect(result.workedMinutes).toBeCloseTo(540, 0); // full 9h — grace minutes credited
  });

  it('fixed: beyond-grace late check-in is NOT credited — every minute counts', () => {
    // 09:25 on an 09:00 shift, grace 10 → 15 min late, worked from 09:25.
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:25', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('late');
    expect(result.lateMinutes).toBeCloseTo(15, 0);
    expect(result.workedMinutes).toBeCloseTo(515, 0); // 18:00 − 09:25
  });

  it('fixed: early check-in is never clamped — pre-shift time stays', () => {
    // 08:50 on an 09:00 shift → worked from 08:50, not clamped to shift start.
    const result = computeDailySummary(
      [
        punch({ hhmm: '08:50', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      FIXED_SHIFT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.workedMinutes).toBeCloseTo(550, 0); // 18:00 − 08:50
  });

  it('split: within-grace first-block check-in credits the first block from shift start', () => {
    const SPLIT: ShiftSnapshot = { ...FIXED_SHIFT, shiftType: 'split' };
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:07', punchType: 'CHECK_IN' }),
        punch({ hhmm: '13:00', punchType: 'CHECK_OUT' }),
        punch({ hhmm: '14:00', punchType: 'CHECK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      SPLIT,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('present');
    // block 1: 13:00 − 09:00 = 240, block 2: 18:00 − 14:00 = 240 → 480
    expect(result.workedMinutes).toBeCloseTo(480, 0);
  });

  it('break: within-grace check-in credits worked time from shift start', () => {
    const BREAK: ShiftSnapshot = { ...FIXED_SHIFT, shiftType: 'break' };
    // 09:06 in, 18:00 out, break 13:00–13:30 → (18:00 − 09:00) − 30 = 510.
    const result = computeDailySummary(
      [
        punch({ hhmm: '09:06', punchType: 'CHECK_IN' }),
        punch({ hhmm: '13:00', punchType: 'BREAK_OUT' }),
        punch({ hhmm: '13:30', punchType: 'BREAK_IN' }),
        punch({ hhmm: '18:00', punchType: 'CHECK_OUT' }),
      ],
      BREAK,
      NO_OT_POLICY,
      DATE,
    );
    expect(result.status).toBe('present');
    expect(result.workedMinutes).toBeCloseTo(510, 0); // 540 − 30 break
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pairSessions — shared check-in/out pairing (self-service day endpoint + split)
// ────────────────────────────────────────────────────────────────────────────

describe('pairSessions', () => {
  it('pairs a single check-in / check-out into one closed session', () => {
    const sessions = pairSessions([
      mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
      mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].in.toISOString()).toBe('2026-04-20T09:00:00.000Z');
    expect(sessions[0].out?.toISOString()).toBe('2026-04-20T18:00:00.000Z');
  });

  it('leaves an unmatched check-in open (out=null)', () => {
    const sessions = pairSessions([mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN')]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].out).toBeNull();
  });

  it('pairs multiple blocks (CI/CO/CI/CO) into two sessions', () => {
    const sessions = pairSessions([
      mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
      mkPunch('2026-04-20T13:00:00Z', 'CHECK_OUT'),
      mkPunch('2026-04-20T14:00:00Z', 'CHECK_IN'),
      mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].in.toISOString()).toBe('2026-04-20T14:00:00.000Z');
    expect(sessions[1].out?.toISOString()).toBe('2026-04-20T18:00:00.000Z');
  });

  it('sorts out-of-order punches before pairing', () => {
    const sessions = pairSessions([
      mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
      mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].in.toISOString()).toBe('2026-04-20T09:00:00.000Z');
    expect(sessions[0].out?.toISOString()).toBe('2026-04-20T18:00:00.000Z');
  });

  it('ignores non-punch event types (STATUS_SET, BREAK_*)', () => {
    const sessions = pairSessions([
      mkPunch('2026-04-20T08:00:00Z', 'STATUS_SET'),
      mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
      mkPunch('2026-04-20T12:00:00Z', 'BREAK_OUT'),
      mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].in.toISOString()).toBe('2026-04-20T09:00:00.000Z');
    expect(sessions[0].out?.toISOString()).toBe('2026-04-20T18:00:00.000Z');
  });

  it('returns an empty array for no punch events', () => {
    expect(pairSessions([])).toEqual([]);
  });

  it('two consecutive check-ins → first stays open, second pairs with the checkout', () => {
    const sessions = pairSessions([
      mkPunch('2026-04-20T09:00:00Z', 'CHECK_IN'),
      mkPunch('2026-04-20T10:00:00Z', 'CHECK_IN'),
      mkPunch('2026-04-20T18:00:00Z', 'CHECK_OUT'),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].out).toBeNull();
    expect(sessions[1].in.toISOString()).toBe('2026-04-20T10:00:00.000Z');
    expect(sessions[1].out?.toISOString()).toBe('2026-04-20T18:00:00.000Z');
  });
});
