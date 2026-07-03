import { describe, it, expect } from 'vitest';
import { computeAllowedMemberIds, graceElapsed } from '../erp-member-cap.helpers';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── computeAllowedMemberIds ──────────────────────────────────────────────────

describe('computeAllowedMemberIds', () => {
  it('owner is always included even at limit 1 (owner + zero others)', () => {
    // limit 1 → owner only; no room for any "other".
    expect(computeAllowedMemberIds('owner', ['o1', 'o2', 'o3'], 1)).toEqual(['owner']);
  });

  it('limit 2 → owner + the oldest 1 other', () => {
    // othersOldestFirst is oldest→newest; keep owner + first (oldest) other.
    expect(computeAllowedMemberIds('owner', ['o1', 'o2', 'o3'], 2)).toEqual(['owner', 'o1']);
  });

  it('owner always present even when owner is not among the oldest', () => {
    // Owner record is the newest join, yet must NEVER be dropped. limit 3 keeps
    // owner + oldest 2 others.
    expect(computeAllowedMemberIds('owner', ['o1', 'o2', 'o3', 'o4'], 3)).toEqual([
      'owner',
      'o1',
      'o2',
    ]);
  });

  it('limit >= total returns everyone (owner first, then all others)', () => {
    expect(computeAllowedMemberIds('owner', ['o1', 'o2'], 5)).toEqual(['owner', 'o1', 'o2']);
    // exactly at total (owner + 2 = 3, limit 3)
    expect(computeAllowedMemberIds('owner', ['o1', 'o2'], 3)).toEqual(['owner', 'o1', 'o2']);
  });

  it('limit -1 (UNLIMITED) returns everyone regardless of count', () => {
    expect(computeAllowedMemberIds('owner', ['o1', 'o2', 'o3', 'o4', 'o5'], -1)).toEqual([
      'owner',
      'o1',
      'o2',
      'o3',
      'o4',
      'o5',
    ]);
  });

  it('owner null → oldest `limit` others (no owner record to reserve a seat)', () => {
    expect(computeAllowedMemberIds(null, ['o1', 'o2', 'o3', 'o4'], 2)).toEqual(['o1', 'o2']);
  });

  it('owner null + limit -1 → all others', () => {
    expect(computeAllowedMemberIds(null, ['o1', 'o2', 'o3'], -1)).toEqual(['o1', 'o2', 'o3']);
  });

  it('total length never exceeds the limit (capped)', () => {
    const out = computeAllowedMemberIds('owner', ['o1', 'o2', 'o3', 'o4', 'o5'], 3);
    expect(out.length).toBe(3);
  });

  it('does not mutate its inputs', () => {
    const others = ['o1', 'o2', 'o3'];
    const copy = [...others];
    computeAllowedMemberIds('owner', others, 2);
    expect(others).toEqual(copy);
  });
});

// ── graceElapsed ─────────────────────────────────────────────────────────────

describe('graceElapsed', () => {
  const now = new Date('2026-06-23T00:00:00Z');

  it('false when no clock', () => {
    expect(graceElapsed(null, 7, now)).toBe(false);
  });

  it('false within the window', () => {
    expect(graceElapsed(new Date(now.getTime() - 3 * MS_PER_DAY), 7, now)).toBe(false);
  });

  it('true once the window has fully elapsed', () => {
    expect(graceElapsed(new Date(now.getTime() - 8 * MS_PER_DAY), 7, now)).toBe(true);
  });

  it('graceDays 0 elapses immediately', () => {
    expect(graceElapsed(new Date(now.getTime() - 1), 0, now)).toBe(true);
  });
});
