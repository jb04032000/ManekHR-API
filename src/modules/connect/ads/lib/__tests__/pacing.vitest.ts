import { describe, it, expect } from 'vitest';
import { targetImpressionsPerMinute, shouldThrottle } from '../pacing';

describe('targetImpressionsPerMinute', () => {
  it('(100, 10, 40) -> 250', () => {
    expect(targetImpressionsPerMinute(100, 10, 40)).toBe(250);
  });

  it('(100, 10, 30) -> 333 (floored)', () => {
    expect(targetImpressionsPerMinute(100, 10, 30)).toBe(333);
  });

  it('minutesLeft 0 -> 0', () => {
    expect(targetImpressionsPerMinute(100, 0, 40)).toBe(0);
  });

  it('avgCpm 0 -> 0', () => {
    expect(targetImpressionsPerMinute(100, 10, 0)).toBe(0);
  });
});

describe('shouldThrottle', () => {
  it('target 0 -> true', () => {
    expect(shouldThrottle(0, 0)).toBe(true);
  });

  it('target negative -> true', () => {
    expect(shouldThrottle(0, -5)).toBe(true);
  });

  it('lastMinute 300, target 250: 300 <= 250*1.2=300 -> false', () => {
    expect(shouldThrottle(300, 250)).toBe(false);
  });

  it('lastMinute 301, target 250: 301 > 250*1.2=300 -> true', () => {
    expect(shouldThrottle(301, 250)).toBe(true);
  });
});
