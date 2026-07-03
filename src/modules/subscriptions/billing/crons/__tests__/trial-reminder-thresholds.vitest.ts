import { describe, it, expect } from 'vitest';
import {
  TRIAL_NUDGE_THRESHOLDS,
  reminderThresholdsForWindow,
  dueReminderThresholds,
} from '../trial-reminder.thresholds';

/**
 * Phase-2 ERP pricing — trial nudge cadence.
 *
 * The trial reminder is NO LONGER a single email per cycle. It is a small,
 * fixed set of nudges fired at distinct `daysRemaining` thresholds derived
 * from the admin-configurable window (`reminderEmailDaysBeforeEnd`, default 5).
 *
 * Derivation under test (`reminderThresholdsForWindow`):
 *   - canonical nudge points = [5, 2, 1] (last-stretch cadence)
 *   - keep only points <= window
 *   - always include the window value itself as the first (earliest) nudge,
 *     so admins setting a smaller window still get an opening reminder
 *   - de-duped + sorted descending
 *
 * Firing under test (`dueReminderThresholds`): for a given daysRemaining a
 * threshold T fires when daysRemaining === T. Each T is deduped per-trial by
 * the cron via a `trial:<subId>:d<T>` key, so a trial gets ~2-3 nudges total
 * across its final days — never a daily barrage.
 */
describe('trial reminder — threshold derivation', () => {
  it('default window (5) yields the 3-nudge cadence [5, 2, 1]', () => {
    expect(reminderThresholdsForWindow(5)).toEqual([5, 2, 1]);
  });

  it('canonical constant is [5, 2, 1]', () => {
    expect(TRIAL_NUDGE_THRESHOLDS).toEqual([5, 2, 1]);
  });

  it('window of 3 clamps to [3, 2, 1] (window boundary always included)', () => {
    // 5 is dropped (> window); window value 3 is injected as the opener.
    expect(reminderThresholdsForWindow(3)).toEqual([3, 2, 1]);
  });

  it('window of 2 clamps to [2, 1]', () => {
    expect(reminderThresholdsForWindow(2)).toEqual([2, 1]);
  });

  it('window of 1 clamps to [1] (single nudge, never daily)', () => {
    expect(reminderThresholdsForWindow(1)).toEqual([1]);
  });

  it('window of 7 still caps at the canonical cadence + window opener [7, 5, 2, 1]', () => {
    expect(reminderThresholdsForWindow(7)).toEqual([7, 5, 2, 1]);
  });

  it('returns at most 3-4 nudges (never one-per-day)', () => {
    for (const w of [1, 2, 3, 5, 7, 10, 14]) {
      expect(reminderThresholdsForWindow(w).length).toBeLessThanOrEqual(4);
    }
  });

  it('a degenerate window (0 or negative) falls back to a single same-day nudge', () => {
    expect(reminderThresholdsForWindow(0)).toEqual([1]);
    expect(reminderThresholdsForWindow(-3)).toEqual([1]);
  });
});

describe('trial reminder — which thresholds fire today', () => {
  it('fires exactly the matching threshold on its day (default window)', () => {
    expect(dueReminderThresholds(5, 5)).toEqual([5]);
    expect(dueReminderThresholds(2, 5)).toEqual([2]);
    expect(dueReminderThresholds(1, 5)).toEqual([1]);
  });

  it('fires NOTHING on the in-between days — proving it is NOT a daily email', () => {
    // 4 and 3 days out are deliberately silent under the [5,2,1] cadence.
    expect(dueReminderThresholds(4, 5)).toEqual([]);
    expect(dueReminderThresholds(3, 5)).toEqual([]);
  });

  it('fires nothing outside the window (daysRemaining above the largest threshold)', () => {
    expect(dueReminderThresholds(6, 5)).toEqual([]);
    expect(dueReminderThresholds(10, 5)).toEqual([]);
  });

  it('respects a shrunk window — day 3 fires only when the window includes 3', () => {
    expect(dueReminderThresholds(3, 3)).toEqual([3]); // window 3 -> opener fires
    expect(dueReminderThresholds(3, 5)).toEqual([]); // window 5 -> day 3 is silent
  });

  it('a 1-day window only ever fires on the final day', () => {
    expect(dueReminderThresholds(1, 1)).toEqual([1]);
    expect(dueReminderThresholds(2, 1)).toEqual([]);
  });
});
