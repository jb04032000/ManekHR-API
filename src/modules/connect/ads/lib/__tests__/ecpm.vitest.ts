import { describe, it, expect } from 'vitest';
import { ecpm, score } from '../ecpm';

describe('ecpm', () => {
  it('billingEvent cpm: returns bid directly', () => {
    expect(ecpm({ billingEvent: 'cpm', bid: 40, predictedCtr: 0.05 })).toBe(40);
  });

  it('billingEvent cpc: predictedCtr 0.01, bid 4 -> 40', () => {
    expect(ecpm({ billingEvent: 'cpc', bid: 4, predictedCtr: 0.01 })).toBe(40);
  });
});

describe('score', () => {
  it('score(40, 1) -> 40', () => {
    expect(score(40, 1)).toBe(40);
  });

  it('score(40, 0) -> 34', () => {
    expect(score(40, 0)).toBe(34);
  });

  it('score(40, 0.5) -> 37', () => {
    expect(score(40, 0.5)).toBe(37);
  });
});
