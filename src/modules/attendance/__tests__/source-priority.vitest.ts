/**
 * source-priority.vitest.ts
 *
 * Tests for dominantSource function and SOURCE_PRIORITY map in compute.ts.
 * Verifies that kiosk source is correctly positioned between device_push (5) and connector (3).
 * M-01 Task 1.
 */
import { describe, it, expect } from 'vitest';
import {
  dominantSource,
  type EventInput,
  type AttendanceEventSource,
} from '../projection/compute';

function makeEvent(source: AttendanceEventSource): EventInput {
  return {
    timestamp: new Date(),
    punchType: 'CHECK_IN',
    statusValue: null,
    source,
  };
}

describe('dominantSource — kiosk source priority', () => {
  it('Test 1: returns kiosk when only a kiosk event is present', () => {
    const events: EventInput[] = [makeEvent('kiosk')];
    expect(dominantSource(events)).toBe('kiosk');
  });

  it('Test 2: returns device_push when device_push and kiosk are both present (5 > 4)', () => {
    const events: EventInput[] = [makeEvent('kiosk'), makeEvent('device_push')];
    expect(dominantSource(events)).toBe('device_push');
  });

  it('Test 3: returns kiosk when kiosk and connector are both present (4 > 3)', () => {
    const events: EventInput[] = [makeEvent('connector'), makeEvent('kiosk')];
    expect(dominantSource(events)).toBe('kiosk');
  });

  it('Test 4: returns manual_override when manual_override and kiosk are both present (7 > 4)', () => {
    const events: EventInput[] = [makeEvent('kiosk'), makeEvent('manual_override')];
    expect(dominantSource(events)).toBe('manual_override');
  });

  it('Test 5: SOURCE_PRIORITY values are manual_override=7, regularization=6, device_push=5, kiosk=4, connector=3, file_upload=2, auto_cron=1, manual=0', () => {
    // Verify ordering by comparing dominantSource results
    // manual_override > regularization
    expect(dominantSource([makeEvent('manual_override'), makeEvent('regularization')])).toBe('manual_override');
    // regularization > device_push
    expect(dominantSource([makeEvent('regularization'), makeEvent('device_push')])).toBe('regularization');
    // device_push > kiosk
    expect(dominantSource([makeEvent('device_push'), makeEvent('kiosk')])).toBe('device_push');
    // kiosk > connector
    expect(dominantSource([makeEvent('kiosk'), makeEvent('connector')])).toBe('kiosk');
    // connector > file_upload
    expect(dominantSource([makeEvent('connector'), makeEvent('file_upload')])).toBe('connector');
    // file_upload > auto_cron
    expect(dominantSource([makeEvent('file_upload'), makeEvent('auto_cron')])).toBe('file_upload');
    // auto_cron > manual
    expect(dominantSource([makeEvent('auto_cron'), makeEvent('manual')])).toBe('auto_cron');
  });
});
